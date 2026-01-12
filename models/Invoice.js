const mongoose = require('mongoose');

const invoiceSchema = new mongoose.Schema(
  {
    items: [
      {
        _id: {
          type: mongoose.Schema.Types.ObjectId,
          required: true
        },
        name: {
          type: String,
          required: true
        },
        price: {
          type: Number,
          required: true
        },
        stock: {
          type: Number,
          required: true,
          default: 1
        }
      }
    ],
    total: {
      type: Number,
      required: true
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Invoice', invoiceSchema);
