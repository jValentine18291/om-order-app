// seed.js — populates the items table with mock catalogue data.
// Run with: npm run seed
// Safe to re-run: clears items first.

const db = require("./db");

const items = [
  // item_code, barcode, description, brand, uom, unit_price
  ["SZEN 140051111", "140051111", "Shoe Clutch",   "Zenoah", "PCS", 9.50],
  ["SZEN 165151220", "165151220", "Clutch Spring", "Zenoah", "PCS", 2.50],
  ["SZEN 591443601", "591443601", "Clutch Drum",   "Zenoah", "PCS", 19.90],
];

const clear = db.prepare("DELETE FROM items");
const insert = db.prepare(`
  INSERT INTO items (item_code, barcode, description, brand, uom, unit_price)
  VALUES (?, ?, ?, ?, ?, ?)
`);

const seed = db.transaction(() => {
  clear.run();
  for (const row of items) insert.run(...row);
});

seed();
console.log(`Seeded ${items.length} mock items into om_orders.db`);
