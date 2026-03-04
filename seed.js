// const mongoose = require("mongoose");
// const dotenv = require("dotenv");
// const ProductOnline = require("./models/ProductOnline");

// dotenv.config();

// const connectDB = async () => {
//     try {
//         await mongoose.connect('mongodb+srv://andrehdaher2003:UdVBUjufCUd79dqc@travelstory.svfos.mongodb.net/internet?retryWrites=true&w=majority&appName=travelstory')
//         console.log("MongoDB Connected ✅");
//     }
//     catch (err) {
//         console.error(err.message);
//         process.exit(1);
//     }
// }

// connectDB();
// const data = [
// {
//     name: "NETFLIX",
//     type: "subscription",
//     note: "ad",
//     cards: [
//         {
//             title: "نتفلكس 3 شهور",
//             description: "يعمل على جهازين ويلزم وجود VPN",
//             name:'NETFLIX',
//             image:'https://res.cloudinary.com/dcbcn7poy/image/upload/v1772644949/NETFLIX_abml9y.jpg',

//             price: 1200,
//             priceOnweb: 1160,
//             min: 1,
//             multiplier: 1,
//             url: "https://alesostore.com/index?page=products&cat=24",
//             btntext: "شراء",
//             btnbg: "bg-red-600",
//             hoverbtn: "bg-red-900",
//             spanbg: "bg-red-600",
//             bgdown: "bg-gradient-to-br from-gray-900/60 to-gray-900/40",
//             border: "border-gray-800"
//         },
//         {
//             title: "نتفلكس شهري",
//             description: "يعمل على جهازين ويلزم وجود VPN",
//             price: 470,
//                         name:'NETFLIX',
//             image:'https://res.cloudinary.com/dcbcn7poy/image/upload/v1772644949/NETFLIX_abml9y.jpg',
//             priceOnweb: 464,
//             min: 1,
//             multiplier: 1,
//             url: "https://alesostore.com/index?page=products&cat=24",
//             btntext: "شراء",
//             btnbg: "bg-red-600",
//             hoverbtn: "bg-red-900",
//             spanbg: "bg-red-600",
//             bgdown: "bg-gradient-to-br from-gray-900/60 to-gray-900/40",
//             border: "border-gray-800"
//         }
//     ]
// }
// ];

// async function seed() {
//     await ProductOnline.insertMany(data);
//     console.log("Data Inserted ✅");
//     process.exit();
// }

// seed();