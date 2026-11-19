import assert from 'node:assert/strict';
import test from 'node:test';
import http from '../../convex/http.js';
import { TERMS_VERSION } from '../../convex/deliveryLoopPaidPolicy.js';

const path = '/delivery/terms/route-a-39-v2';
const origin = 'https://offline.example.invalid';
const forbiddenContext = new Proxy({}, { get() { throw Error('Terms must not access the datastore, storage or providers'); } });
const read = async () => {
  const route = http.lookup(path, 'GET');
  assert.ok(route, 'exact versioned GET must be registered');
  return route[0]._handler(forbiddenContext, new Request(origin + path));
};

test('versioned French terms are readable without credentials or paid admission and cause no effects', async () => {
  process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED = 'false';
  process.env.BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED = 'false';
  delete process.env.BEBEBONJOUR_PAID_TERMS_URL;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw Error('Terms must not use the network'); };
  let response;
  try { response = await read(); } finally { globalThis.fetch = originalFetch; }
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^text\/html; charset=utf-8$/);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(response.headers.get('x-frame-options'), 'DENY');
  assert.match(response.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(response.headers.get('content-security-policy'), /form-action 'none'/);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('set-cookie'), null);
  const html = await response.text();
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/);
  assert.match(html, /<meta name="robots" content="noindex,nofollow,noarchive">/);
  assert.match(html, /<title>Conditions de l’offre à 39 € · Bébé Bonjour<\/title>/);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.equal((html.match(/<h1\b/g) || []).length, 1);
  assert.match(html, /<h1 id="terms-title">Conditions de l’offre à 39 €<\/h1>/);
  assert.match(html, /<main aria-labelledby="terms-title">/);
  assert.match(html, /<h2>/);
  assert.doesNotMatch(html, /<(?:script|form|input|button|iframe|img)\b|\son\w+=|placeholder|example\.com|à compléter|TODO/i);
  assert.match(html, /line-height:1\.6/);
  assert.match(html, /overflow-wrap:anywhere/);
  assert.match(html, /href="mailto:contact@bebebonjour\.com"/);
  assert.equal(TERMS_VERSION, 'route-a-39-v2');
  assert.match(html, new RegExp(`Version : <strong>${TERMS_VERSION}</strong>`));
  assert.equal(process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED, 'false');
  assert.equal(process.env.BEBEBONJOUR_PAID_DATA_AUTOMATION_ENABLED, 'false');
  assert.equal(process.env.BEBEBONJOUR_PAID_TERMS_URL, undefined);
});

test('terms state the literal settled offer, statutory rights and separate five-test exception', async () => {
  const html = await (await read()).text();
  for (const text of [
    'HAVESOMECODE', '879 252 336 00034', '39 € au total, en une seule fois',
    'français ou en arabe', 'narration audio incluse', 'L’offre comprend deux corrections.',
    'nous la lisons avant toute création', 'nous vous envoyons un lien de paiement de 39 €',
    'La création commence après la confirmation du paiement', 'aucun paiement ne vous est demandé',
    'cinq jours ouvrés après la confirmation du paiement',
    'douze mois à compter de la livraison finale', '30 jours avant la fermeture',
    'texte final', 'audio', 'archive de la page', 'sans renouvellement automatique',
    'sans abonnement', 'particuliers majeurs résidant en France métropolitaine',
    'autorisations parentales nécessaires', 'contact@bebebonjour.com', 'deux jours ouvrés',
    '14 jours', 'droits légaux', 'ne vaut pas renonciation',
    'ne constitue pas une confirmation de remboursement',
    'au maximum cinq essais', '38 € de remise', '1 € à payer',
    'ne constituent pas des ventes à 39 €',
    'Toute personne disposant du lien peut consulter', 'non indexé et révocable',
    'ni pour le marketing, ni pour des démonstrations, ni pour l’entraînement de modèles',
  ]) assert.ok(html.includes(text), `missing settled term: ${text}`);
  assert.doesNotMatch(html, /aperçu gratuit|gratuit et privé pendant 24 heures/i);
  assert.doesNotMatch(html, /remboursement garanti|médiateur agréé|validées par un avocat|hébergement illimité|z@havesomecode|\.fr\b/i);
});

test('only the exact GET version is added; paid and private owner negative routes stay closed', async () => {
  assert.equal(http.lookup('/delivery/terms/route-a-39-v1', 'GET'), null);
  assert.equal(http.lookup(path + '/extra', 'GET'), null);
  assert.equal(http.lookup(path, 'POST'), null);
  process.env.BEBEBONJOUR_PAID_ROUTE_A_ENABLED = 'false';
  const paid = await http.lookup('/delivery', 'GET')[0]._handler(forbiddenContext, new Request(origin + '/delivery?mode=paid_route_a'));
  assert.equal(paid.status, 400);
  assert.deepEqual(await paid.json(), { status: 'error', code: 'paid_route_unavailable' });
  const owner = await http.lookup('/completion/artifact', 'GET')[0]._handler({
    runQuery: async () => { throw Error('forbidden'); },
  }, new Request(origin + '/completion/artifact'));
  assert.equal(owner.status, 403);
  process.env.BEBEBONJOUR_PAID_STRIPE_WEBHOOK_SECRET = 'whsec_SyntheticTermsNegativeRouteOnly123';
  const webhook = await http.lookup('/delivery/payment/webhook', 'POST')[0]._handler(forbiddenContext, new Request(origin + '/delivery/payment/webhook', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }));
  assert.equal(webhook.status, 400);
  assert.deepEqual(await webhook.json(), { status: 'payment_event_signature' });
});
