#!/usr/bin/env node
/**
 * Creates a demo dataset, two dimension tables, and three rule versions.
 * Deterministic: running it twice reuses versions by content hash.
 */
import path from 'node:path';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db.js';
import { ingestDataset } from '../src/engine/dataset.js';
import { ingestDimension } from '../src/engine/dimension.js';
import { saveRule } from '../src/engine/rules.js';

const db = openDatabase(config.dbPath);

const CUSTOMERS = [
  ['C001', 'Acme Industrial', 'enterprise', 'US', '2023-04-11'],
  ['C002', 'Brightline Labs', 'smb', 'US', '2024-01-09'],
  ['C003', 'Cobalt Partners', 'enterprise', 'DE', '2022-11-30'],
  ['C004', 'Delta Works', 'midmarket', 'FR', '2024-06-18'],
  ['C005', 'Evergreen Supply', 'smb', 'US', '2023-09-02'],
  ['C006', 'Foundry Six', 'midmarket', 'GB', '2025-02-14'],
  ['C007', 'Granite Peak', 'enterprise', 'CA', '2022-07-21'],
  ['C008', 'Harbor & Co', 'smb', 'NL', '2024-10-05'],
  ['C009', 'Ironclad Systems', 'enterprise', 'US', '2023-01-17'],
  ['C010', 'Juniper Field', 'smb', 'CA', '2025-03-28'],
];

const ORDERS = [];
const products = [
  ['SKU-100', 'Starter Kit', 49.0, 'hardware'],
  ['SKU-200', 'Pro Bundle', 189.5, 'hardware'],
  ['SKU-300', 'Support Plan', 320.0, 'service'],
  ['SKU-400', 'Training Day', 750.0, 'service'],
  ['SKU-500', 'Add-on Module', 95.25, 'software'],
];
const regions = ['US', 'DE', 'FR', 'GB', 'NL', 'CA'];
const statuses = ['paid', 'paid', 'paid', 'pending', 'refunded'];
let seed = 42;
const rand = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};
for (let i = 1; i <= 240; i += 1) {
  const customer = CUSTOMERS[Math.floor(rand() * CUSTOMERS.length)];
  const product = products[Math.floor(rand() * products.length)];
  const qty = 1 + Math.floor(rand() * 6);
  const discount = Math.floor(rand() * 4) * 0.05;
  const day = 1 + Math.floor(rand() * 28);
  const month = 1 + Math.floor(rand() * 12);
  ORDERS.push({
    order_id: `O${String(i).padStart(4, '0')}`,
    customer_id: customer[0],
    sku: product[0],
    quantity: qty,
    unit_price: product[2],
    discount_pct: discount,
    order_date: `2025-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
    region: regions[Math.floor(rand() * regions.length)],
    status: statuses[Math.floor(rand() * statuses.length)],
    channel: rand() > 0.72 ? 'online' : 'field',
    gross_amount: Math.round(product[2] * qty * 100) / 100,
  });
}

const datasetResult = ingestDataset(db, {
  name: 'demo_orders',
  description: 'Demo order ledger, 240 deterministic rows',
  source: 'seed',
  records: ORDERS,
});

const dimResult = ingestDimension(db, {
  name: 'customers',
  source: 'seed',
  entries: CUSTOMERS.map(([id, company, segment, country, since]) => ({
    key: id,
    value: JSON.stringify({ company, segment, country, since }),
  })),
});

// Lookup returns one scalar, so the demo uses one dimension per attribute.
ingestDimension(db, {
  name: 'customer_segment',
  source: 'seed',
  entries: CUSTOMERS.map(([id, , segment]) => ({ key: id, value: segment })),
});
ingestDimension(db, {
  name: 'customer_region',
  source: 'seed',
  entries: CUSTOMERS.map(([id, , , country]) => ({ key: id, value: country })),
});
ingestDimension(db, {
  name: 'product_category',
  source: 'seed',
  entries: products.map(([sku, , , category]) => ({ key: sku, value: category })),
});
ingestDimension(db, {
  name: 'region_tier',
  source: 'seed',
  entries: [
    { key: 'US', value: 'domestic' },
    { key: 'CA', value: 'nearshore' },
    { key: 'DE', value: 'eu' },
    { key: 'FR', value: 'eu' },
    { key: 'NL', value: 'eu' },
    { key: 'GB', value: 'eu' },
  ],
});

const rules = [
  {
    name: 'net_amount_v1',
    expression:
      'if(status == "refunded", 0, round(gross_amount * (1 - discount_pct), 2))',
    note: 'Net amount charged for the order; refunds contribute zero.',
  },
  {
    name: 'net_amount_v2',
    expression:
      'if(status == "refunded", 0, round(gross_amount * (1 - discount_pct) * if(channel == "online", 1, 0.99), 2))',
    note: 'Variant under evaluation: field orders carry a 1% handling deduction.',
  },
  {
    name: 'segment_bucket',
    expression: `if(
  lookup("customer_segment", customer_id) is null, "unknown",
  if(lookup("customer_segment", customer_id) == "enterprise" and lookup("region_tier", region) == "domestic", "key-account",
    if(lookup("customer_segment", customer_id) == "enterprise", "strategic",
      if(lookup("customer_segment", customer_id) == "midmarket", "growth", "volume")))
)`,
    note: 'Conditional mapping combining two dimension tables.',
  },
  {
    name: 'month_key',
    expression: 'substr(order_date, 1, 7)',
    note: 'Calendar month used as the group key.',
  },
  {
    name: 'revenue_by_month',
    expression: 'sum(net_amount_v1)',
    note: 'Group output: total net revenue.',
  },
];

const saved = rules.map((r) =>
  saveRule(db, {
    name: r.name,
    expression: r.expression,
    note: r.note,
    source: 'seed',
    mode: r.name === 'revenue_by_month' ? 'group' : 'row',
    knownColumns: r.name === 'revenue_by_month' ? null : JSON.parse(datasetResult.version.columns_json).map((c) => c.name),
    knownDimensions: ['customers', 'customer_segment', 'customer_region', 'product_category', 'region_tier'],
  }),
);

process.stdout.write(
  JSON.stringify(
    {
      datasetVersionId: datasetResult.version.id,
      datasetContentHash: datasetResult.version.content_hash,
      rows: datasetResult.version.row_count,
      columnNames: JSON.parse(datasetResult.version.columns_json).map((c) => c.name),
      dimensionVersionIds: {
        customers: dimResult.version.id,
      },
      rules: saved.map((s) => ({ name: s.version.name, id: s.version.id, versionNo: s.version.version_no })),
      dbPath: config.dbPath,
    },
    null,
    2,
  ) + '\n',
);
