const mongoose = require('mongoose');

const productShema = new mongoose.Schema({
    name: {
        type: String,
        required: true,
    },
    price: {
        type: Number,
        required: true,
    },
    // title:{
    //     type : String,
    //     required : true,
    // },
    priceCost: {
        type: Number,
        required: true,
    },
    priceWolesale: {
        type: Number,
        required: true,
    },

    description: {
        type: String,
        required: true,
    },
    category: {
        type: String,
        required: true,
    },
    imageUrl: {
        type: String,
        required: true,
    },
    stock: {
        type: Number,
        required: true,
        default: 1,
    }


})

module.exports = mongoose.model('Product', productShema);