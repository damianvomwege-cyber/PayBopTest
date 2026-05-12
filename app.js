const gradients = [
  "linear-gradient(135deg, #0f766e, #ef6f5e)",
  "linear-gradient(135deg, #31572c, #90a955)",
  "linear-gradient(135deg, #263238, #4db6ac)",
  "linear-gradient(135deg, #7c2d12, #f59e0b)",
  "linear-gradient(135deg, #1f2937, #60a5fa)",
  "linear-gradient(135deg, #7f1d1d, #fb7185)"
];

let state = {
  authenticated: false,
  testMode: true,
  currentAccount: { displayName: "Google Account" },
  accounts: [],
  creditsCents: 0,
  cardConnected: false,
  cardLast4: "",
  payoutConnected: false,
  paymentsConfigured: false,
  googleClientId: "",
  csrfToken: "",
  listings: [],
  activity: []
};
let selectedListingId = null;

const views = {
  market: document.querySelector("#marketView"),
  wallet: document.querySelector("#walletView"),
  create: document.querySelector("#createView")
};

const listingGrid = document.querySelector("#listingGrid");
const searchInput = document.querySelector("#searchInput");
const authScreen = document.querySelector("#authScreen");
const appShell = document.querySelector("#appShell");
const detailModal = document.querySelector("#detailModal");
const signupModal = document.querySelector("#signupModal");
const confirmModal = document.querySelector("#confirmModal");
const toast = document.querySelector("#toast");
const useCreditsInput = document.querySelector("#useCredits");
let googleButtonRendered = false;

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => showView(button.dataset.view));
});

document.querySelectorAll("[data-close]").forEach((button) => {
  button.addEventListener("click", () => closeModal(button.dataset.close));
});

document.querySelector("#signupButton").addEventListener("click", () => openModal(signupModal));
document.querySelector("#googleSwitchButton").addEventListener("click", showGoogleLogin);
document.querySelector("#buyButton").addEventListener("click", buySelectedListing);
document.querySelector("#convertButton").addEventListener("click", requestConvert);
document.querySelector("#cancelConvertButton").addEventListener("click", cancelConvert);
document.querySelector("#confirmConvertButton").addEventListener("click", confirmConvert);
document.querySelector("#clearActivityButton").addEventListener("click", clearActivity);

searchInput.addEventListener("input", renderListings);
document.querySelector("#listingForm").addEventListener("submit", createListing);
document.querySelector("#connectPayoutButton").addEventListener("click", startPayoutOnboarding);
document.querySelector("#testLoginForm").addEventListener("submit", loginTestAccount);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    [detailModal, signupModal, confirmModal].forEach((modal) => {
      if (!modal.hidden) closeModal(modal.id);
    });
  }
});

loadInitialState();

async function loadInitialState() {
  try {
    const data = await apiRequest("/api/state");
    state = data;
    render();
  } catch (error) {
    showToast(error.message);
  }
}

async function apiRequest(path, options = {}) {
  const headers = {
    Accept: "application/json",
    ...(options.headers || {})
  };

  if (options.body) {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = state.csrfToken;
  }

  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin"
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

function render() {
  renderAuthState();
  if (!state.authenticated) return;
  renderSummary();
  renderListings();
  renderActivity();
}

function renderAuthState() {
  authScreen.hidden = state.authenticated;
  appShell.hidden = !state.authenticated;
  if (!state.authenticated) setupGoogleButton();
}

function showGoogleLogin() {
  authScreen.hidden = false;
  appShell.hidden = true;
  setupGoogleButton();
}

function renderSummary() {
  const formattedCredits = formatMoneyFromCents(state.creditsCents);
  document.querySelector("#creditBalance").textContent = formattedCredits;
  document.querySelector("#walletCredits").textContent = `${formattedCredits} Credits`;
  document.querySelector("#listingCount").textContent = String(state.listings.length);
  document.querySelector("#cardStatus").textContent = state.cardConnected
    ? (state.testMode ? "Test verbunden" : "Stripe verbunden")
    : "Kein Payout";
  document.querySelector("#cardHint").textContent = state.cardConnected
    ? (state.testMode ? "Bereit fuer Test-Convert." : "Bereit fuer Stripe Transfer.")
    : (state.testMode ? "Test-Payout ist fuer Convert erforderlich." : "Stripe Connect ist fuer Convert erforderlich.");
  document.querySelector("#signupButton").textContent = state.cardConnected
    ? "Payout bearbeiten"
    : "Payout verbinden";
  document.querySelector("#currentAccount").textContent =
    state.currentAccount?.displayName || "Google Account";
}

function renderListings() {
  const query = searchInput.value.trim().toLowerCase();
  const listings = state.listings.filter((listing) => {
    const haystack = `${listing.title} ${listing.description} ${listing.sellerName}`.toLowerCase();
    return haystack.includes(query);
  });

  listingGrid.innerHTML = "";

  if (listings.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "Keine Preise gefunden. Fuege im Bereich Preis erstellen einen neuen Preis hinzu.";
    listingGrid.append(empty);
    return;
  }

  listings.forEach((listing, index) => {
    const card = document.createElement("article");
    card.className = "listing-card";
    card.addEventListener("click", () => openListing(listing.id));
    card.innerHTML = `
      <div class="listing-cover" style="--cover: ${listing.cover || gradients[index % gradients.length]}"></div>
      <div class="listing-body">
        <span class="label">${escapeHtml(listing.sellerName)}</span>
        <h3>${escapeHtml(listing.title)}</h3>
        <p>${escapeHtml(listing.description)}</p>
        <div class="price-row">
          <span class="price-pill">${formatMoneyFromCents(listing.priceCents)}</span>
          ${
            listing.ownedByCurrentUser
              ? `<button class="delete-listing-button" type="button" data-listing-id="${listing.id}">Loeschen</button>`
              : `<span class="label">Details</span>`
          }
        </div>
      </div>
    `;
    const deleteButton = card.querySelector(".delete-listing-button");
    if (deleteButton) {
      deleteButton.addEventListener("click", (event) => {
        event.stopPropagation();
        deleteListing(deleteButton.dataset.listingId);
      });
    }
    listingGrid.append(card);
  });
}

function renderActivity() {
  const activityList = document.querySelector("#activityList");
  activityList.innerHTML = "";

  if (state.activity.length === 0) {
    const item = document.createElement("li");
    item.textContent = "Noch keine Aktivitaet.";
    activityList.append(item);
    return;
  }

  state.activity.slice(0, 12).forEach((entry) => {
    const item = document.createElement("li");
    item.textContent = entry;
    activityList.append(item);
  });
}

function showView(viewName) {
  Object.entries(views).forEach(([name, view]) => {
    view.classList.toggle("active", name === viewName);
  });

  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewName);
  });
}

function openListing(id) {
  const listing = state.listings.find((item) => item.id === id);
  if (!listing) return;

  selectedListingId = id;
  document.querySelector("#detailTitle").textContent = listing.title;
  document.querySelector("#detailDescription").textContent = listing.description;
  document.querySelector("#detailPrice").textContent = formatMoneyFromCents(listing.priceCents);
  document.querySelector("#detailVisual").style.setProperty("--cover", listing.cover);
  configurePaymentOption(listing);
  openModal(detailModal);
}

async function buySelectedListing() {
  const listing = state.listings.find((item) => item.id === selectedListingId);
  if (!listing) return;

  try {
    const data = await apiRequest("/api/buy", {
      method: "POST",
      body: JSON.stringify({
        listingId: listing.id
      })
    });
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    if (data.state) {
      state = data.state;
      closeModal("detailModal");
      render();
    }
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

function configurePaymentOption(listing) {
  const paymentBox = document.querySelector("#paymentBox");
  const paymentHint = document.querySelector("#paymentHint");

  useCreditsInput.checked = false;
  useCreditsInput.disabled = true;
  paymentBox.hidden = false;

  if (listing.ownedByCurrentUser) {
    useCreditsInput.disabled = true;
    paymentHint.textContent =
      "Eigene Listings koennen nicht selbst gekauft werden. Ein anderer Account muss kaufen.";
    return;
  }

  paymentHint.textContent = state.testMode
    ? "Test-Kauf: Der Seller bekommt sofort Credits, ohne echte Zahlung."
    : "Buy oeffnet Stripe Checkout. Credits werden erst nach bestaetigtem Stripe-Webhook gutgeschrieben.";
}

async function createListing(event) {
  event.preventDefault();

  try {
    const data = await apiRequest("/api/listings", {
      method: "POST",
      body: JSON.stringify({
        title: document.querySelector("#listingTitle").value.trim(),
        description: document.querySelector("#listingDescription").value.trim(),
        price: Number(document.querySelector("#listingPrice").value)
      })
    });
    state = data.state;
    event.target.reset();
    showView("market");
    render();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function startPayoutOnboarding() {
  try {
    const data = await apiRequest("/api/stripe/connect/onboard", {
      method: "POST",
      body: JSON.stringify({})
    });
    if (data.url) {
      window.location.href = data.url;
      return;
    }
    if (data.state) {
      state = data.state;
      closeModal("signupModal");
      render();
    }
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function loginTestAccount(event) {
  event.preventDefault();
  const displayName = document.querySelector("#testName").value.trim();

  try {
    const data = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({
        displayName,
        email: `${displayName.toLowerCase().replace(/[^a-z0-9]/g, "") || "test"}@test.local`
      })
    });
    state = data.state;
    event.target.reset();
    render();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function loginWithGoogleCredential(credential) {
  try {
    const data = await apiRequest("/api/login", {
      method: "POST",
      body: JSON.stringify({ credential })
    });
    state = data.state;
    render();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

function setupGoogleButton() {
  const googleButton = document.querySelector("#googleButton");
  const configError = document.querySelector("#loginConfigError");
  const testForm = document.querySelector("#testLoginForm");
  const authModeLabel = document.querySelector("#authModeLabel");
  const authTitle = document.querySelector("#authTitle");
  const authText = document.querySelector("#authText");

  if (state.testMode) {
    googleButton.hidden = true;
    configError.hidden = true;
    testForm.hidden = false;
    authModeLabel.textContent = "Test Login";
    authTitle.textContent = "Im Testmodus anmelden";
    authText.textContent = "Nutze z.B. Seller und Buyer als Test-Accounts, um Kauf und Credits zu pruefen.";
    return;
  }

  testForm.hidden = true;
  authModeLabel.textContent = "Google Login";
  authTitle.textContent = "Mit Google anmelden";
  authText.textContent = "Du musst dich anmelden, bevor du Marketplace, Wallet und Preise benutzen kannst.";

  if (!state.googleClientId) {
    googleButton.hidden = true;
    configError.hidden = false;
    return;
  }

  configError.hidden = true;
  googleButton.hidden = false;

  if (googleButtonRendered) return;

  const script = document.createElement("script");
  script.src = "https://accounts.google.com/gsi/client";
  script.async = true;
  script.defer = true;
  script.onload = () => {
    window.google.accounts.id.initialize({
      client_id: state.googleClientId,
      callback: (response) => loginWithGoogleCredential(response.credential)
    });
    window.google.accounts.id.renderButton(googleButton, {
      theme: "outline",
      size: "large",
      width: 360
    });
    googleButtonRendered = true;
  };
  document.head.append(script);
}

function requestConvert() {
  if (!state.cardConnected) {
    openModal(signupModal);
    showToast(state.testMode ? "Verbinde zuerst deinen Test-Payout Account." : "Verbinde zuerst deinen Stripe Payout Account.");
    return;
  }

  if (state.creditsCents <= 0) {
    showToast("Du hast keine Credits zum Umwandeln.");
    return;
  }

  document.querySelector("#confirmText").textContent =
    `Du wandelst ${formatMoneyFromCents(state.creditsCents)} Credits in ${formatMoneyFromCents(state.creditsCents)} Geld um. Der Server zieht die Credits zuerst ab und zahlt genau diesen Betrag aus.`;
  openModal(confirmModal);
}

async function cancelConvert() {
  closeModal("confirmModal");

  try {
    const data = await apiRequest("/api/convert/cancel", {
      method: "POST",
      body: JSON.stringify({})
    });
    state = data.state;
    render();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function confirmConvert() {
  try {
    const data = await apiRequest("/api/convert", {
      method: "POST",
      body: JSON.stringify({})
    });
    state = data.state;
    closeModal("confirmModal");
    render();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteListing(listingId) {
  try {
    const data = await apiRequest("/api/listings/delete", {
      method: "POST",
      body: JSON.stringify({ listingId })
    });
    state = data.state;
    render();
    showToast(data.message);
  } catch (error) {
    showToast(error.message);
  }
}

async function clearActivity() {
  try {
    const data = await apiRequest("/api/activity/clear", {
      method: "POST",
      body: JSON.stringify({})
    });
    state = data.state;
    renderActivity();
  } catch (error) {
    showToast(error.message);
  }
}

function openModal(modal) {
  modal.hidden = false;
}

function closeModal(id) {
  document.querySelector(`#${id}`).hidden = true;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatMoneyFromCents(cents) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2
  }).format(cents / 100);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}
