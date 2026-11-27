const { EventEmitter } = require("events");

// Tiny in-process event bus so low-level modules (e.g. products.js) can announce
// things like "this product was restocked" without needing the Discord client.
// Listeners are attached once the client is ready (see events/clientReady.js).
//
// Events:
//   "restock" { guildId, productCode, stock }  — a product went from 0 to >0 items
const bus = new EventEmitter();
bus.setMaxListeners(20);

module.exports = bus;
