const mongoose = require("mongoose");

mongoose.set("strictQuery", true);

module.exports = class Database {
  // Resolves once MongoDB is connected; rejects (fast) if it can't be reached.
  async connectToMongo(mongoURI) {
    if (!mongoURI) throw new Error("MONGODB_URI is not set.");
    await mongoose.connect(mongoURI, { serverSelectionTimeoutMS: 10000 });
    // Make sure unique indexes (order ids, one store per guild…) exist.
    await Promise.all(Object.values(mongoose.models).map((m) => m.syncIndexes().catch(() => {})));
    console.log(`Connected to MongoDB database "${mongoose.connection.name}".`);
  }
};
