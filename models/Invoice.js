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
       customerName: {
      type: String,
      required: true
    },
      customerPhone: {
      type: Number,
      required: true
    },

    payments: [{
      amount: { type: Number, required: true , default: 0 },
      date: { type: Date, required: true , default: Date.now },
      details: { type: String },
      FormTitle: { type: String }

    }],
    paymentAmount: {
      type: Number,
      required: true,
      default: 0
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Invoice', invoiceSchema);
