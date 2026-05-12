# PayBop Test

Marketplace mit Testmodus und optionalem Live-Modus fuer Google Login, Stripe Checkout und Stripe Connect.

## Testmodus

Standard ist `TEST_MODE=true`. Damit kannst du lokal ohne echte Google- oder Stripe-Keys testen:

- Test-Accounts wie `Seller` und `Buyer`
- Listings erstellen und loeschen
- Buy simuliert eine Zahlung
- Seller bekommt sofort Credits
- Payout verbinden simuliert Stripe Connect
- Convert setzt Credits auf `0`

```powershell
npm install
copy .env.example .env
npm start
```

Dann `http://localhost:5174` oeffnen.

## Live-Modus

Fuer echte Zahlungen:

```env
APP_URL=https://deine-domain.com
SESSION_SECRET=ein-langer-zufaelliger-secret
TEST_MODE=false
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
```

Stripe Webhook:

```text
https://deine-domain.com/api/stripe/webhook
```

Event:

```text
checkout.session.completed
```

Im Live-Modus gibt es keinen Test-Login: Google ID-Token wird serverseitig verifiziert, Kaeufer zahlen ueber Stripe Checkout, und Convert erstellt einen Stripe Connect Transfer.
