require("dotenv").config();
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const Stripe = require("stripe");
const { OAuth2Client } = require("google-auth-library");

const PORT = Number(process.env.PORT || 5174);
const ROOT = __dirname;
const DATA_FILE = process.env.VERCEL
  ? path.join(os.tmpdir(), "paybop-test-data.json")
  : path.join(ROOT, "data.json");
const APP_URL = process.env.APP_URL || `http://localhost:${PORT}`;
const SESSION_COOKIE = "paybop_sid";
const CSRF_HEADER = "x-csrf-token";
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const MAX_BODY_BYTES = 16 * 1024;
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const TEST_MODE = process.env.TEST_MODE !== "false";

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

const gradients = [
  "linear-gradient(135deg, #0f766e, #ef6f5e)",
  "linear-gradient(135deg, #31572c, #90a955)",
  "linear-gradient(135deg, #263238, #4db6ac)",
  "linear-gradient(135deg, #7c2d12, #f59e0b)",
  "linear-gradient(135deg, #1f2937, #60a5fa)",
  "linear-gradient(135deg, #7f1d1d, #fb7185)"
];

let db = loadDb();
const rateLimits = new Map();
const stripe = !TEST_MODE && STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const googleClient = !TEST_MODE && GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

async function appHandler(req, res) {
  try {
    setSecurityHeaders(res);

    if (req.url.startsWith("/api/stripe/webhook")) {
      await handleStripeWebhook(req, res);
      return;
    }

    const session = getOrCreateSession(req, res);

    if (req.url.startsWith("/api/")) {
      await handleApi(req, res, session);
      return;
    }

    serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Server error." });
  }
}

if (require.main === module) {
  const server = http.createServer(appHandler);
  server.listen(PORT, () => {
    console.log(`PayBop Test running at http://localhost:${PORT}`);
  });
}

module.exports = appHandler;

async function handleApi(req, res, session) {
  if (!checkRateLimit(session.id)) {
    sendJson(res, 429, { error: "Zu viele Aktionen. Bitte kurz warten." });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/api/state") {
    sendJson(res, 200, getPublicState(session));
    return;
  }

  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  if (!isSameOrigin(req) || req.headers[CSRF_HEADER] !== session.csrfToken) {
    sendJson(res, 403, { error: "Security check failed." });
    return;
  }

  const body = await readJsonBody(req);

  if (url.pathname === "/api/login") return loginAccount(res, session, body);

  if (!session.userId) {
    sendJson(res, 401, { error: "Bitte zuerst mit Google anmelden." });
    return;
  }

  if (url.pathname === "/api/listings") return createListing(res, session, body);
  if (url.pathname === "/api/listings/delete") return deleteListing(res, session, body);
  if (url.pathname === "/api/buy") return buyListing(res, session, body);
  if (url.pathname === "/api/stripe/connect/onboard") return createConnectOnboarding(res, session);
  if (url.pathname === "/api/convert") return convertCredits(res, session);
  if (url.pathname === "/api/convert/cancel") return cancelConvert(res, session);
  if (url.pathname === "/api/activity/clear") return clearActivity(res, session);
  sendJson(res, 404, { error: "API route not found." });
}

async function handleStripeWebhook(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed." });
    return;
  }

  if (!stripe || !STRIPE_WEBHOOK_SECRET) {
    sendJson(res, 500, { error: "Stripe webhook is not configured." });
    return;
  }

  const rawBody = await readRawBody(req);
  const signature = req.headers["stripe-signature"];
  let event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
  } catch (error) {
    sendJson(res, 400, { error: "Invalid Stripe signature." });
    return;
  }

  if (event.type === "checkout.session.completed") {
    fulfillCheckoutSession(event.data.object);
  }

  sendJson(res, 200, { received: true });
}

function fulfillCheckoutSession(checkoutSession) {
  if (checkoutSession.payment_status !== "paid") return;

  const orderId = checkoutSession.metadata?.orderId;
  const order = db.orders[orderId];
  if (!order || order.status === "paid") return;

  const expectedAmount = order.amountCents;
  if (checkoutSession.amount_total !== expectedAmount || checkoutSession.currency !== order.currency) {
    order.status = "amount_mismatch";
    addLedger("stripe_amount_mismatch", order.sellerId, 0, {
      orderId,
      expectedAmount,
      actualAmount: checkoutSession.amount_total
    });
    saveDb();
    return;
  }

  const listing = db.listings.find((item) => item.id === order.listingId);
  const seller = getAccount(order.sellerId);
  const buyer = getAccount(order.buyerId);

  seller.creditsCents += expectedAmount;
  order.status = "paid";
  order.paymentIntentId = checkoutSession.payment_intent;
  order.paidAt = Date.now();
  addLedger("stripe_checkout_paid", seller.id, expectedAmount, {
    orderId,
    checkoutSessionId: checkoutSession.id,
    paymentIntentId: checkoutSession.payment_intent
  });
  addActivity(seller.id, `Bezahlter Verkauf: ${listing?.title || "Listing"} brachte ${formatMoney(expectedAmount)} Credits.`);
  addActivity(buyer.id, `Stripe Zahlung abgeschlossen: ${listing?.title || "Listing"} fuer ${formatMoney(expectedAmount)}.`);
  saveDb();
}

function createListing(res, session, body) {
  const account = getAccount(session.userId);
  const title = sanitizeText(body.title, 48);
  const description = sanitizeText(body.description, 220);
  const priceCents = dollarsToCents(body.price);

  if (!title || !description || priceCents < 100 || priceCents > 100000) {
    sendJson(res, 400, { error: "Listing ist ungueltig. Preis muss zwischen $1 und $1000 liegen." });
    return;
  }

  db.listings.unshift({
    id: randomId(),
    title,
    description,
    priceCents,
    sellerId: session.userId,
    sellerName: account.displayName,
    cover: gradients[db.listings.length % gradients.length],
    createdAt: Date.now()
  });

  addActivity(session.userId, `Neuer Preis erstellt: ${title} fuer ${formatMoney(priceCents)}.`);
  saveDb();
  sendJson(res, 201, {
    message: "Preis wurde serverseitig validiert und hinzugefuegt.",
    state: getPublicState(session)
  });
}

async function loginAccount(res, session, body) {
  if (TEST_MODE) {
    return loginTestAccount(res, session, body);
  }

  if (!GOOGLE_CLIENT_ID || !googleClient) {
    sendJson(res, 500, { error: "Echtes Google Login ist nicht konfiguriert. Setze GOOGLE_CLIENT_ID." });
    return;
  }

  if (!body.credential) {
    sendJson(res, 400, { error: "Google Credential Token fehlt." });
    return;
  }

  const ticket = await googleClient.verifyIdToken({
    idToken: String(body.credential),
    audience: GOOGLE_CLIENT_ID
  });
  const payload = ticket.getPayload();
  const email = sanitizeEmail(payload?.email);
  const displayName = sanitizeText(payload?.name || (email ? email.split("@")[0] : ""), 28);
  const googleSubject = String(payload?.sub || "");

  if (!email || !googleSubject || payload?.email_verified !== true) {
    sendJson(res, 401, { error: "Google Token ist ungueltig oder E-Mail ist nicht verifiziert." });
    return;
  }

  const username = googleSubject;

  let account = Object.values(db.accounts).find((item) => item.username === username);

  if (!account) {
    account = {
      id: randomId(),
      username,
      email,
      displayName,
      googleSubject,
      creditsCents: 0,
      stripeAccountId: "",
      payoutConnected: false,
      activity: [`Google Account verbunden: ${displayName}.`]
    };
    db.accounts[account.id] = account;
  } else {
    account.email = email;
    account.displayName = displayName || account.displayName;
    account.googleSubject = googleSubject || account.googleSubject || "";
  }

  session.userId = account.id;
  session.csrfToken = randomId();
  addActivity(account.id, `Mit Google angemeldet als ${account.displayName}.`);
  saveDb();

  sendJson(res, 200, {
    message: `Mit Google angemeldet als ${account.displayName}.`,
    state: getPublicState(session)
  });
}

function loginTestAccount(res, session, body) {
  const displayName = sanitizeText(body.displayName || "Test User", 28);
  const email = sanitizeEmail(body.email) || `${normalizeUsername(displayName) || "test"}@test.local`;
  const username = `test:${email}`;

  let account = Object.values(db.accounts).find((item) => item.username === username);

  if (!account) {
    account = {
      id: randomId(),
      username,
      email,
      displayName,
      googleSubject: "",
      creditsCents: 0,
      stripeAccountId: "",
      payoutConnected: false,
      activity: [`Test Account erstellt: ${displayName}.`]
    };
    db.accounts[account.id] = account;
  } else {
    account.displayName = displayName || account.displayName;
  }

  session.userId = account.id;
  session.csrfToken = randomId();
  addActivity(account.id, `Im Testmodus angemeldet als ${account.displayName}.`);
  saveDb();

  sendJson(res, 200, {
    message: `Testmodus: angemeldet als ${account.displayName}.`,
    state: getPublicState(session)
  });
}

function deleteListing(res, session, body) {
  const index = db.listings.findIndex((item) => item.id === body.listingId);

  if (index === -1) {
    sendJson(res, 404, { error: "Listing nicht gefunden." });
    return;
  }

  const listing = db.listings[index];

  if (listing.sellerId !== session.userId) {
    sendJson(res, 403, { error: "Du kannst nur deine eigenen Preise loeschen." });
    return;
  }

  db.listings.splice(index, 1);
  addActivity(session.userId, `Preis geloescht: ${listing.title}.`);
  saveDb();
  sendJson(res, 200, {
    message: "Preis geloescht.",
    state: getPublicState(session)
  });
}

async function buyListing(res, session, body) {
  const listing = db.listings.find((item) => item.id === body.listingId);

  if (!listing) {
    sendJson(res, 404, { error: "Listing nicht gefunden." });
    return;
  }

  const buyer = getAccount(session.userId);
  const seller = getAccount(listing.sellerId);
  const priceCents = listing.priceCents;

  if (priceCents <= 0 || !Number.isInteger(priceCents)) {
    sendJson(res, 409, { error: "Listing hat keinen sicheren Preis." });
    return;
  }

  if (listing.sellerId === session.userId) {
    sendJson(res, 403, { error: "Du kannst dein eigenes Listing nicht kaufen." });
    return;
  }

  if (TEST_MODE) {
    seller.creditsCents += priceCents;
    addLedger("test_checkout_paid", seller.id, priceCents, {
      listingId: listing.id,
      buyerId: session.userId
    });
    addActivity(session.userId, `Test-Kauf abgeschlossen: ${listing.title} fuer ${formatMoney(priceCents)}.`);
    addActivity(seller.id, `Test-Verkauf: ${listing.title} brachte ${formatMoney(priceCents)} Credits.`);
    saveDb();
    sendJson(res, 200, {
      message: `Test-Kauf abgeschlossen. Seller erhielt ${formatMoney(priceCents)} Credits.`,
      state: getPublicState(session)
    });
    return;
  }

  if (!stripe) {
    sendJson(res, 500, { error: "Stripe ist nicht konfiguriert. Setze STRIPE_SECRET_KEY." });
    return;
  }

  const orderId = randomId();
  const checkoutSession = await stripe.checkout.sessions.create({
    mode: "payment",
    payment_method_types: ["card"],
    client_reference_id: session.userId,
    customer_email: buyer.email,
    line_items: [
      {
        price_data: {
          currency: "usd",
          unit_amount: priceCents,
          product_data: {
            name: listing.title,
            description: listing.description
          }
        },
        quantity: 1
      }
    ],
    metadata: {
      orderId,
      listingId: listing.id,
      buyerId: session.userId,
      sellerId: listing.sellerId
    },
    success_url: `${APP_URL}/?payment=success`,
    cancel_url: `${APP_URL}/?payment=cancel`
  });

  db.orders[orderId] = {
    id: orderId,
    listingId: listing.id,
    buyerId: session.userId,
    sellerId: listing.sellerId,
    amountCents: priceCents,
    currency: "usd",
    checkoutSessionId: checkoutSession.id,
    status: "checkout_created",
    createdAt: Date.now()
  };

  addActivity(session.userId, `Stripe Checkout gestartet: ${listing.title} fuer ${formatMoney(priceCents)}.`);
  saveDb();
  sendJson(res, 200, {
    message: "Stripe Checkout gestartet.",
    url: checkoutSession.url
  });
}

async function createConnectOnboarding(res, session) {
  const account = getAccount(session.userId);

  if (TEST_MODE) {
    if (!account.stripeAccountId) {
      account.stripeAccountId = `acct_test_${randomId().slice(0, 12)}`;
    }
    account.payoutConnected = true;
    addActivity(session.userId, "Test-Payout Account verbunden.");
    saveDb();
    sendJson(res, 200, {
      message: "Testmodus: Payout Account verbunden.",
      state: getPublicState(session)
    });
    return;
  }

  if (!stripe) {
    sendJson(res, 500, { error: "Stripe ist nicht konfiguriert. Setze STRIPE_SECRET_KEY." });
    return;
  }

  if (!account.stripeAccountId) {
    const connectedAccount = await stripe.accounts.create({
      type: "express",
      email: account.email,
      capabilities: {
        transfers: { requested: true }
      },
      metadata: {
        paybopAccountId: account.id
      }
    });
    account.stripeAccountId = connectedAccount.id;
    account.payoutConnected = false;
  }

  const accountLink = await stripe.accountLinks.create({
    account: account.stripeAccountId,
    refresh_url: `${APP_URL}/?connect=refresh`,
    return_url: `${APP_URL}/?connect=return`,
    type: "account_onboarding"
  });

  addActivity(session.userId, "Stripe Connect Onboarding gestartet.");
  saveDb();
  sendJson(res, 200, {
    message: "Stripe Connect Onboarding gestartet.",
    url: accountLink.url
  });
}

async function convertCredits(res, session) {
  const account = getAccount(session.userId);

  if (TEST_MODE) {
    if (!account.stripeAccountId) {
      sendJson(res, 403, { error: "Verbinde zuerst deinen Test-Payout Account." });
      return;
    }

    if (account.creditsCents <= 0) {
      sendJson(res, 400, { error: "Keine Credits zum Umwandeln." });
      return;
    }

    const payoutCents = account.creditsCents;
    account.creditsCents = 0;
    addLedger("test_payout", account.id, -payoutCents, {
      testPayoutId: `po_test_${randomId().slice(0, 12)}`
    });
    addActivity(session.userId, `Test-Convert: ${formatMoney(payoutCents)} ausgezahlt, Credits sind jetzt $0.00.`);
    saveDb();
    sendJson(res, 200, {
      message: `Testmodus: ${formatMoney(payoutCents)} converted. Credits sind jetzt $0.00.`,
      state: getPublicState(session)
    });
    return;
  }

  if (!stripe) {
    sendJson(res, 500, { error: "Stripe ist nicht konfiguriert. Setze STRIPE_SECRET_KEY." });
    return;
  }

  if (!account.stripeAccountId) {
    sendJson(res, 403, { error: "Verbinde zuerst deinen Stripe Payout Account." });
    return;
  }

  if (account.creditsCents <= 0) {
    sendJson(res, 400, { error: "Keine Credits zum Umwandeln." });
    return;
  }

  const payoutCents = account.creditsCents;
  const transfer = await stripe.transfers.create({
    amount: payoutCents,
    currency: "usd",
    destination: account.stripeAccountId,
    metadata: {
      paybopAccountId: account.id
    }
  });

  account.creditsCents = 0;
  account.payoutConnected = true;
  addLedger("stripe_transfer", account.id, -payoutCents, { transferId: transfer.id });
  addActivity(session.userId, `Stripe Transfer erstellt: ${formatMoney(payoutCents)} an deinen Payout Account.`);
  saveDb();
  sendJson(res, 200, {
    message: `${formatMoney(payoutCents)} als Stripe Transfer gesendet. Credits sind jetzt $0.00.`,
    state: getPublicState(session)
  });
}

function cancelConvert(res, session) {
  const account = getAccount(session.userId);
  addActivity(session.userId, `Convert gecancelt. ${formatMoney(account.creditsCents)} Credits bleiben verfuegbar.`);
  saveDb();
  sendJson(res, 200, {
    message: "Convert gecancelt. Credits bleiben erhalten.",
    state: getPublicState(session)
  });
}

function clearActivity(res, session) {
  const account = getAccount(session.userId);
  account.activity = [];
  saveDb();
  sendJson(res, 200, { state: getPublicState(session) });
}

function getPublicState(session) {
  if (!session.userId) {
    return {
      authenticated: false,
      testMode: TEST_MODE,
      currentAccount: null,
      accounts: [],
      creditsCents: 0,
      payoutConnected: false,
      paymentsConfigured: TEST_MODE || Boolean(stripe),
      googleClientId: TEST_MODE ? "" : GOOGLE_CLIENT_ID,
      csrfToken: session.csrfToken,
      listings: [],
      activity: []
    };
  }

  const account = getAccount(session.userId);

  return {
    authenticated: true,
    testMode: TEST_MODE,
    currentAccount: {
      id: account.id,
      displayName: account.displayName,
      email: account.email,
      stripeAccountId: account.stripeAccountId || ""
    },
    accounts: [],
    creditsCents: account.creditsCents,
    cardConnected: TEST_MODE ? Boolean(account.stripeAccountId) : Boolean(account.stripeAccountId),
    cardLast4: account.stripeAccountId ? account.stripeAccountId.slice(-4) : "",
    payoutConnected: Boolean(account.stripeAccountId),
    paymentsConfigured: TEST_MODE || Boolean(stripe),
    googleClientId: TEST_MODE ? "" : GOOGLE_CLIENT_ID,
    csrfToken: session.csrfToken,
    listings: db.listings.map((listing) => ({
      id: listing.id,
      title: listing.title,
      description: listing.description,
      priceCents: listing.priceCents,
      sellerName: listing.sellerId === session.userId ? "Du" : getSellerName(listing),
      ownedByCurrentUser: listing.sellerId === session.userId,
      cover: listing.cover
    })),
    activity: account.activity
  };
}

function getOrCreateSession(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  const verified = verifySessionCookie(cookies[SESSION_COOKIE]);

  if (verified && db.sessions[verified.id]) {
    return db.sessions[verified.id];
  }

  const id = randomId();
  const csrfToken = randomId();
  db.sessions[id] = { id, userId: null, csrfToken, createdAt: Date.now() };
  saveDb();

  const value = signSessionId(id);
  res.setHeader("Set-Cookie", `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800`);
  return db.sessions[id];
}

function getAccount(userId) {
  if (!db.accounts[userId]) {
    db.accounts[userId] = {
      id: userId,
      username: normalizeUsername("Google Account"),
      displayName: "Google Account",
      creditsCents: 0,
      stripeAccountId: "",
      payoutConnected: false,
      activity: []
    };
  }

  if (!db.accounts[userId].displayName) {
    db.accounts[userId].displayName = "Google Account";
  }

  if (!db.accounts[userId].username) {
    db.accounts[userId].username = normalizeUsername(db.accounts[userId].displayName);
  }

  if (!Number.isInteger(db.accounts[userId].creditsCents)) {
    db.accounts[userId].creditsCents = 0;
  }

  if (!db.accounts[userId].stripeAccountId) {
    db.accounts[userId].stripeAccountId = "";
  }

  return db.accounts[userId];
}

function getSellerName(listing) {
  const account = db.accounts[listing.sellerId];
  return account?.displayName || listing.sellerName || "Creator";
}

function addActivity(userId, message) {
  const account = getAccount(userId);
  account.activity.unshift(message);
  account.activity = account.activity.slice(0, 50);
}

function addLedger(type, accountId, amountCents, meta) {
  db.ledger.push({
    id: randomId(),
    type,
    accountId,
    amountCents,
    meta,
    createdAt: Date.now()
  });
}

function loadDb() {
  try {
    const raw = fs.readFileSync(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      accounts: parsed.accounts || {},
      sessions: parsed.sessions || {},
      listings: Array.isArray(parsed.listings) ? parsed.listings : [],
      orders: parsed.orders || {},
      ledger: Array.isArray(parsed.ledger) ? parsed.ledger : []
    };
  } catch {
    return {
      accounts: {},
      sessions: {},
      listings: [],
      orders: {},
      ledger: []
    };
  }
}

function saveDb() {
  const tempFile = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tempFile, JSON.stringify(db, null, 2));
  fs.renameSync(tempFile, DATA_FILE);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname === "/" ? "/index.html" : url.pathname;
  const decoded = decodeURIComponent(pathname);
  const requested = path.normalize(path.join(ROOT, decoded));

  if (!requested.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(requested, (error, content) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(requested)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(content);
  });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
        reject(new Error("Body too large."));
        req.destroy();
      }
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES * 16) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function setSecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' https://accounts.google.com/gsi/client; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://*.googleusercontent.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );
}

function isSameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
}

function checkRateLimit(key) {
  const now = Date.now();
  const windowMs = 10000;
  const limit = 45;
  const current = rateLimits.get(key) || { count: 0, resetAt: now + windowMs };

  if (now > current.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  current.count += 1;
  rateLimits.set(key, current);
  return current.count <= limit;
}

function parseCookies(header) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim().split("="))
      .filter((parts) => parts.length === 2)
      .map(([key, value]) => [key, decodeURIComponent(value)])
  );
}

function signSessionId(id) {
  const signature = crypto.createHmac("sha256", SESSION_SECRET).update(id).digest("base64url");
  return `${id}.${signature}`;
}

function verifySessionCookie(value) {
  if (!value || !value.includes(".")) return null;
  const [id, signature] = value.split(".");
  const expected = signSessionId(id).split(".")[1];

  if (signature.length !== expected.length) return null;

  const valid = crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  return valid ? { id } : null;
}

function randomId() {
  return crypto.randomBytes(16).toString("hex");
}

function sanitizeText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, maxLength);
}

function normalizeUsername(value) {
  return sanitizeText(value, 28).toLowerCase().replace(/[^a-z0-9_-]/g, "");
}

function sanitizeEmail(value) {
  const email = String(value || "").trim().toLowerCase().slice(0, 120);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function dollarsToCents(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round(number * 100);
}

function formatMoney(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
