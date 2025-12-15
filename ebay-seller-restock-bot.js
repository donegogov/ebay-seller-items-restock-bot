// trading-restock-bot.js
require('dotenv').config();
const axios = require('axios');
const xml2js = require('xml2js');

const {
  EBAY_ENVIRONMENT,
  EBAY_CLIENT_ID,
  EBAY_CLIENT_SECRET,
  EBAY_REFRESH_TOKEN,
  TARGET_ITEM_IDS,
  TARGET_STOCK,
  POLL_INTERVAL_MS,
} = process.env;

if (!EBAY_CLIENT_ID || !EBAY_CLIENT_SECRET || !EBAY_REFRESH_TOKEN || !TARGET_ITEM_IDS) {
  console.error('Missing env vars. Need EBAY_CLIENT_ID, EBAY_CLIENT_SECRET, EBAY_REFRESH_TOKEN, TARGET_ITEM_IDS.');
  process.exit(1);
}

const IS_SANDBOX = (EBAY_ENVIRONMENT || 'production').toLowerCase() === 'sandbox';
const IDENTITY_BASE = IS_SANDBOX
  ? 'https://api.sandbox.ebay.com/identity/v1/oauth2/token'
  : 'https://api.ebay.com/identity/v1/oauth2/token';
const TRADING_ENDPOINT = IS_SANDBOX
  ? 'https://api.sandbox.ebay.com/ws/api.dll'
  : 'https://api.ebay.com/ws/api.dll';

// Germany = site 77
const EBAY_SITE_ID = IS_SANDBOX ? '0' : '77';

const ITEM_IDS = TARGET_ITEM_IDS.split(',').map(s => s.trim()).filter(Boolean);
const DESIRED_QTY = Number(TARGET_STOCK || 3);
const POLL_MS = Number(POLL_INTERVAL_MS || 300000);

let cachedToken = null;
let tokenExpiresAt = 0;

// ----- Get OAuth access token from refresh token -----
async function getAccessToken() {
  const now = Date.now();
  if (cachedToken && now < tokenExpiresAt - 60_000) {
    return cachedToken;
  }

  const basic = Buffer.from(`${EBAY_CLIENT_ID}:${EBAY_CLIENT_SECRET}`).toString('base64');
  const params = new URLSearchParams();
  params.append('grant_type', 'refresh_token');
  params.append('refresh_token', EBAY_REFRESH_TOKEN);

  console.log('[AUTH] Refreshing access token...');
  const res = await axios.post(IDENTITY_BASE, params.toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': `Basic ${basic}`,
    },
  });

  const data = res.data;
  cachedToken = data.access_token;
  const expiresIn = data.expires_in || 3600;
  tokenExpiresAt = Date.now() + expiresIn * 1000;
  console.log('[AUTH] Access token refreshed, expires in', expiresIn, 'seconds');
  return cachedToken;
}

// ----- Build ReviseInventoryStatus XML body -----
function buildReviseInventoryStatusRequest(itemIds, quantity) {
  const inventoryStatusBlocks = itemIds
    .map(
      id => `
    <InventoryStatus>
      <ItemID>${id}</ItemID>
      <Quantity>${quantity}</Quantity>
    </InventoryStatus>`
    )
    .join('');

  return `<?xml version="1.0" encoding="utf-8"?>
<ReviseInventoryStatusRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  ${inventoryStatusBlocks}
</ReviseInventoryStatusRequest>`;
}

// ----- Call Trading API -----
async function callTradingAPI(xmlBody, accessToken) {
  try {
    const res = await axios.post(TRADING_ENDPOINT, xmlBody, {
      headers: {
        'Content-Type': 'text/xml',
        'X-EBAY-API-CALL-NAME': 'ReviseInventoryStatus',
        'X-EBAY-API-SITEID': EBAY_SITE_ID,
        'X-EBAY-API-COMPATIBILITY-LEVEL': '1209',
        // OAuth user token:
        'X-EBAY-API-IAF-TOKEN': accessToken,
        // App name is optional but nice to send:
        'X-EBAY-API-APP-NAME': EBAY_CLIENT_ID,
      },
    });

    return res.data; // XML string
  } catch (err) {
    if (err.response) {
      console.error('[TRADING ERROR] HTTP', err.response.status);
      console.error(err.response.data);
    } else {
      console.error('[TRADING ERROR]', err.message);
    }
    throw err;
  }
}

// ----- Parse response and log results -----
async function parseAndLogResponse(xml) {
  const parsed = await xml2js.parseStringPromise(xml, {
    explicitArray: false,
    ignoreAttrs: false,
  });

  const resp = parsed.ReviseInventoryStatusResponse;
  if (!resp) {
    console.error('[PARSE] Unexpected response:', parsed);
    return;
  }

  const ack = resp.Ack;
  console.log('[TRADING] Ack =', ack);

  if (resp.Errors) {
    const errors = Array.isArray(resp.Errors) ? resp.Errors : [resp.Errors];
    for (const e of errors) {
      console.error(
        '[ERROR]',
        e.ErrorCode,
        e.ShortMessage,
        e.LongMessage || ''
      );
    }
  }

  if (resp.InventoryStatus) {
    const statuses = Array.isArray(resp.InventoryStatus)
      ? resp.InventoryStatus
      : [resp.InventoryStatus];

    for (const s of statuses) {
      console.log(
        `[ITEM] ItemID=${s.ItemID} | SetQty=${DESIRED_QTY}${
        s.SKU ? ` | SKU=${s.SKU}` : ''
      }`)
    }
  }
}

// ----- Main poll loop -----
async function processItems() {
  console.log('--- TRADING POLL START ---');
  console.log(
    `[INFO] Updating ItemIDs: ${ITEM_IDS.join(', ')} | target quantity = ${DESIRED_QTY}`
  );

  let token;
  try {
    token = await getAccessToken();
  } catch (err) {
    console.error('[FATAL] Could not obtain access token, aborting this poll.');
    return;
  }

  const xmlBody = buildReviseInventoryStatusRequest(ITEM_IDS, DESIRED_QTY);
  console.log('[DEBUG] Sending ReviseInventoryStatus request for', ITEM_IDS.length, 'items');

  try {
    const xmlResponse = await callTradingAPI(xmlBody, token);
    await parseAndLogResponse(xmlResponse);
  } catch (err) {
    console.error('[FATAL] ReviseInventoryStatus call failed.');
  }

  console.log('--- TRADING POLL END ---');
}

// ----- Start loop -----
(async () => {
  console.log('eBay Trading API restock bot starting...');
  console.log(`Environment: ${IS_SANDBOX ? 'SANDBOX' : 'PRODUCTION'} (site=${EBAY_SITE_ID})`);
  console.log(`Polling every ${POLL_MS / 1000} seconds`);

  await processItems();

  setInterval(() => {
    processItems().catch(err =>
      console.error('[FATAL] processItems error:', err)
    );
  }, POLL_MS);
})();

