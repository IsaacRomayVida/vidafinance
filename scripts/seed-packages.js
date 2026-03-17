/**
 * Seed Firestore with 10+ travel packages for VIDA Travel.
 *
 * Usage:
 *   # Against emulator (default)
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 node scripts/seed-packages.js
 *
 *   # Against production (requires GOOGLE_APPLICATION_CREDENTIALS or default creds)
 *   node scripts/seed-packages.js --production
 *
 *   # Wipe existing packages first
 *   node scripts/seed-packages.js --clean
 */

const admin = require("firebase-admin");

/* ------------------------------------------------------------------ */
/*  Init                                                               */
/* ------------------------------------------------------------------ */

const isProduction = process.argv.includes("--production");
const shouldClean  = process.argv.includes("--clean");

if (!admin.apps.length) {
  admin.initializeApp({
    projectId: "vida-finance",
  });
}

const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ------------------------------------------------------------------ */
/*  Package catalog                                                    */
/* ------------------------------------------------------------------ */

const packages = [
  {
    slug: "cancun-all-inclusive-7n",
    name: { en: "Cancun All-Inclusive Escape", es: "Escape Todo Incluido Cancún" },
    description: {
      en: "7 nights at a beachfront resort in Cancun's Hotel Zone with unlimited food, drinks, and entertainment. Perfect for families and couples alike.",
      es: "7 noches en un resort frente al mar en la Zona Hotelera de Cancún con comida, bebidas y entretenimiento ilimitados. Perfecto para familias y parejas.",
    },
    destination: "Cancún, Quintana Roo",
    hotel: "Grand Fiesta Americana Coral Beach",
    priceMXN: 28500,
    adultRate: 28500,
    childRate: 14250,
    durationNights: 7,
    images: [
      "packages/cancun-all-inclusive-7n/hero.jpg",
      "packages/cancun-all-inclusive-7n/pool.jpg",
      "packages/cancun-all-inclusive-7n/beach.jpg",
    ],
    includes: {
      en: ["Round-trip airport transfers", "All meals & drinks", "Beach access & water sports", "Kids club (ages 4-12)", "Wi-Fi"],
      es: ["Traslados aeropuerto ida y vuelta", "Todas las comidas y bebidas", "Acceso a playa y deportes acuáticos", "Club de niños (4-12 años)", "Wi-Fi"],
    },
    availability: { startDate: "2026-06-01", endDate: "2026-12-20", spotsTotal: 40, spotsRemaining: 40 },
  },
  {
    slug: "los-cabos-luxury-5n",
    name: { en: "Los Cabos Luxury Retreat", es: "Retiro de Lujo en Los Cabos" },
    description: {
      en: "5 nights at a premier resort in Cabo San Lucas with ocean-view suites, spa credits, and a sunset sailing excursion included.",
      es: "5 noches en un resort premier en Cabo San Lucas con suites con vista al mar, créditos de spa y excursión en velero al atardecer incluida.",
    },
    destination: "Los Cabos, Baja California Sur",
    hotel: "Waldorf Astoria Los Cabos Pedregal",
    priceMXN: 45000,
    adultRate: 45000,
    childRate: 22500,
    durationNights: 5,
    images: [
      "packages/los-cabos-luxury-5n/hero.jpg",
      "packages/los-cabos-luxury-5n/suite.jpg",
      "packages/los-cabos-luxury-5n/arch.jpg",
    ],
    includes: {
      en: ["Ocean-view suite", "Daily breakfast", "$2,000 MXN spa credit", "Sunset sailing excursion", "Private beach access"],
      es: ["Suite con vista al mar", "Desayuno diario", "$2,000 MXN crédito de spa", "Excursión en velero al atardecer", "Acceso a playa privada"],
    },
    availability: { startDate: "2026-05-15", endDate: "2026-11-30", spotsTotal: 20, spotsRemaining: 20 },
  },
  {
    slug: "riviera-maya-eco-6n",
    name: { en: "Riviera Maya Eco-Adventure", es: "Eco-Aventura Riviera Maya" },
    description: {
      en: "6 nights combining luxury eco-lodges with cenote diving, Mayan ruins tours, and snorkeling in the world's second-largest reef.",
      es: "6 noches combinando eco-lodges de lujo con buceo en cenotes, tours a ruinas mayas y snorkel en el segundo arrecife más grande del mundo.",
    },
    destination: "Riviera Maya, Quintana Roo",
    hotel: "Hotel Xcaret Arte",
    priceMXN: 34000,
    adultRate: 34000,
    childRate: 17000,
    durationNights: 6,
    images: [
      "packages/riviera-maya-eco-6n/hero.jpg",
      "packages/riviera-maya-eco-6n/cenote.jpg",
      "packages/riviera-maya-eco-6n/ruins.jpg",
    ],
    includes: {
      en: ["All-inclusive meals", "Xcaret & Xel-Há park access", "Cenote snorkel tour", "Tulum ruins guided visit", "Airport transfers"],
      es: ["Comidas todo incluido", "Acceso a parques Xcaret y Xel-Há", "Tour de snorkel en cenote", "Visita guiada a ruinas de Tulum", "Traslados aeropuerto"],
    },
    availability: { startDate: "2026-04-01", endDate: "2026-12-15", spotsTotal: 30, spotsRemaining: 30 },
  },
  {
    slug: "puerto-vallarta-romantic-4n",
    name: { en: "Puerto Vallarta Romantic Getaway", es: "Escapada Romántica Puerto Vallarta" },
    description: {
      en: "4 nights designed for couples: boutique hotel in the Romantic Zone, private beach dinner, tequila tasting, and couples spa.",
      es: "4 noches diseñadas para parejas: hotel boutique en la Zona Romántica, cena privada en la playa, degustación de tequila y spa para parejas.",
    },
    destination: "Puerto Vallarta, Jalisco",
    hotel: "Hacienda San Angel",
    priceMXN: 22000,
    adultRate: 22000,
    childRate: 11000,
    durationNights: 4,
    images: [
      "packages/puerto-vallarta-romantic-4n/hero.jpg",
      "packages/puerto-vallarta-romantic-4n/dinner.jpg",
      "packages/puerto-vallarta-romantic-4n/terrace.jpg",
    ],
    includes: {
      en: ["Boutique suite with ocean view", "Private beach dinner for 2", "Tequila tasting experience", "Couples spa treatment", "Daily gourmet breakfast"],
      es: ["Suite boutique con vista al mar", "Cena privada en la playa para 2", "Experiencia de degustación de tequila", "Tratamiento de spa para parejas", "Desayuno gourmet diario"],
    },
    availability: { startDate: "2026-05-01", endDate: "2026-12-31", spotsTotal: 15, spotsRemaining: 15 },
  },
  {
    slug: "oaxaca-cultural-5n",
    name: { en: "Oaxaca Cultural Immersion", es: "Inmersión Cultural en Oaxaca" },
    description: {
      en: "5 nights exploring Oaxaca's vibrant culture: mezcal distilleries, cooking classes, Hierve el Agua, Monte Albán, and artisan markets.",
      es: "5 noches explorando la vibrante cultura oaxaqueña: destilerías de mezcal, clases de cocina, Hierve el Agua, Monte Albán y mercados artesanales.",
    },
    destination: "Oaxaca de Juárez, Oaxaca",
    hotel: "Hotel Casa Oaxaca",
    priceMXN: 18500,
    adultRate: 18500,
    childRate: 9250,
    durationNights: 5,
    images: [
      "packages/oaxaca-cultural-5n/hero.jpg",
      "packages/oaxaca-cultural-5n/monte-alban.jpg",
      "packages/oaxaca-cultural-5n/food.jpg",
    ],
    includes: {
      en: ["Boutique hotel stay", "Monte Albán guided tour", "Mezcal distillery visit", "Traditional cooking class", "Hierve el Agua day trip"],
      es: ["Estancia en hotel boutique", "Tour guiado a Monte Albán", "Visita a destilería de mezcal", "Clase de cocina tradicional", "Excursión a Hierve el Agua"],
    },
    availability: { startDate: "2026-03-15", endDate: "2026-12-31", spotsTotal: 25, spotsRemaining: 25 },
  },
  {
    slug: "cdmx-explorer-4n",
    name: { en: "Mexico City Explorer", es: "Explorador Ciudad de México" },
    description: {
      en: "4 nights in the heart of CDMX: Chapultepec Castle, Teotihuacán pyramids, Xochimilco canals, lucha libre, and world-class dining.",
      es: "4 noches en el corazón de CDMX: Castillo de Chapultepec, pirámides de Teotihuacán, canales de Xochimilco, lucha libre y gastronomía de clase mundial.",
    },
    destination: "Ciudad de México, CDMX",
    hotel: "Four Seasons Hotel Mexico City",
    priceMXN: 24000,
    adultRate: 24000,
    childRate: 12000,
    durationNights: 4,
    images: [
      "packages/cdmx-explorer-4n/hero.jpg",
      "packages/cdmx-explorer-4n/teotihuacan.jpg",
      "packages/cdmx-explorer-4n/xochimilco.jpg",
    ],
    includes: {
      en: ["Luxury hotel in Reforma", "Teotihuacán sunrise tour", "Xochimilco trajinera cruise", "Lucha libre VIP tickets", "Street food walking tour"],
      es: ["Hotel de lujo en Reforma", "Tour al amanecer en Teotihuacán", "Paseo en trajinera por Xochimilco", "Boletos VIP de lucha libre", "Tour gastronómico a pie"],
    },
    availability: { startDate: "2026-04-01", endDate: "2026-12-31", spotsTotal: 35, spotsRemaining: 35 },
  },
  {
    slug: "holbox-island-5n",
    name: { en: "Holbox Island Paradise", es: "Paraíso Isla Holbox" },
    description: {
      en: "5 nights on the car-free island of Holbox: bioluminescent waters, whale shark tours (seasonal), hammock-filled beaches, and fresh seafood.",
      es: "5 noches en la isla sin autos de Holbox: aguas bioluminiscentes, tours de tiburón ballena (temporada), playas con hamacas y mariscos frescos.",
    },
    destination: "Isla Holbox, Quintana Roo",
    hotel: "Villas HM Palapas del Mar",
    priceMXN: 21000,
    adultRate: 21000,
    childRate: 10500,
    durationNights: 5,
    images: [
      "packages/holbox-island-5n/hero.jpg",
      "packages/holbox-island-5n/bioluminescence.jpg",
      "packages/holbox-island-5n/hammock.jpg",
    ],
    includes: {
      en: ["Beachfront cabana", "Bioluminescence kayak tour", "Whale shark snorkel (Jun-Sep)", "Golf cart rental (2 days)", "Daily breakfast"],
      es: ["Cabaña frente al mar", "Tour de bioluminiscencia en kayak", "Snorkel con tiburón ballena (Jun-Sep)", "Renta de carrito de golf (2 días)", "Desayuno diario"],
    },
    availability: { startDate: "2026-06-01", endDate: "2026-09-30", spotsTotal: 20, spotsRemaining: 20 },
  },
  {
    slug: "san-miguel-colonial-3n",
    name: { en: "San Miguel de Allende Colonial Charm", es: "Encanto Colonial San Miguel de Allende" },
    description: {
      en: "3 nights in Mexico's most beautiful colonial town: art galleries, hot-air balloon ride, wine tasting in the Guanajuato vineyards, and vibrant nightlife.",
      es: "3 noches en el pueblo colonial más bello de México: galerías de arte, paseo en globo aerostático, degustación de vinos en los viñedos de Guanajuato y vida nocturna vibrante.",
    },
    destination: "San Miguel de Allende, Guanajuato",
    hotel: "Rosewood San Miguel de Allende",
    priceMXN: 19500,
    adultRate: 19500,
    childRate: 9750,
    durationNights: 3,
    images: [
      "packages/san-miguel-colonial-3n/hero.jpg",
      "packages/san-miguel-colonial-3n/balloon.jpg",
      "packages/san-miguel-colonial-3n/parroquia.jpg",
    ],
    includes: {
      en: ["Luxury colonial hotel", "Hot-air balloon ride", "Wine tasting tour", "Art gallery walking tour", "Welcome mezcal cocktail"],
      es: ["Hotel colonial de lujo", "Paseo en globo aerostático", "Tour de degustación de vinos", "Tour a pie por galerías de arte", "Cóctel de bienvenida de mezcal"],
    },
    availability: { startDate: "2026-03-01", endDate: "2026-12-31", spotsTotal: 20, spotsRemaining: 20 },
  },
  {
    slug: "huatulco-beach-6n",
    name: { en: "Huatulco Bays & Beaches", es: "Bahías y Playas de Huatulco" },
    description: {
      en: "6 nights exploring Huatulco's nine pristine bays: snorkeling, boat tours, waterfall hikes, and coffee plantation visits in the Oaxacan coast.",
      es: "6 noches explorando las nueve bahías prístinas de Huatulco: snorkel, tours en lancha, caminatas a cascadas y visitas a plantaciones de café en la costa oaxaqueña.",
    },
    destination: "Huatulco, Oaxaca",
    hotel: "Secrets Huatulco Resort & Spa",
    priceMXN: 26000,
    adultRate: 26000,
    childRate: 13000,
    durationNights: 6,
    images: [
      "packages/huatulco-beach-6n/hero.jpg",
      "packages/huatulco-beach-6n/bay.jpg",
      "packages/huatulco-beach-6n/waterfall.jpg",
    ],
    includes: {
      en: ["All-inclusive resort", "Nine bays boat tour", "Copalitilla waterfall hike", "Coffee plantation tour", "Snorkel gear included"],
      es: ["Resort todo incluido", "Tour en lancha por nueve bahías", "Caminata a cascada Copalitilla", "Tour a plantación de café", "Equipo de snorkel incluido"],
    },
    availability: { startDate: "2026-04-15", endDate: "2026-12-15", spotsTotal: 25, spotsRemaining: 25 },
  },
  {
    slug: "copper-canyon-adventure-5n",
    name: { en: "Copper Canyon Rail Adventure", es: "Aventura en Tren Barrancas del Cobre" },
    description: {
      en: "5 nights riding the legendary Chepe Express through Copper Canyon — four times larger than the Grand Canyon. Includes zip-lining, Tarahumara village visits, and mountain lodge stays.",
      es: "5 noches recorriendo el legendario Chepe Express por las Barrancas del Cobre — cuatro veces más grandes que el Gran Cañón. Incluye tirolesa, visitas a pueblos tarahumaras y estancias en lodges de montaña.",
    },
    destination: "Barrancas del Cobre, Chihuahua",
    hotel: "Hotel Mirador Posada Barrancas",
    priceMXN: 31000,
    adultRate: 31000,
    childRate: 15500,
    durationNights: 5,
    images: [
      "packages/copper-canyon-adventure-5n/hero.jpg",
      "packages/copper-canyon-adventure-5n/train.jpg",
      "packages/copper-canyon-adventure-5n/zipline.jpg",
    ],
    includes: {
      en: ["Chepe Express first-class ticket", "Mountain lodge accommodations", "Canyon zip-line adventure", "Tarahumara village guided tour", "All breakfasts & dinners"],
      es: ["Boleto de primera clase Chepe Express", "Alojamiento en lodges de montaña", "Tirolesa en el cañón", "Tour guiado a pueblo tarahumara", "Todos los desayunos y cenas"],
    },
    availability: { startDate: "2026-04-01", endDate: "2026-11-30", spotsTotal: 15, spotsRemaining: 15 },
  },
  {
    slug: "tulum-wellness-5n",
    name: { en: "Tulum Wellness & Yoga Retreat", es: "Retiro de Bienestar y Yoga en Tulum" },
    description: {
      en: "5 nights of wellness in Tulum: daily yoga sessions, temazcal ceremony, organic farm-to-table dining, cenote meditation, and beachfront relaxation.",
      es: "5 noches de bienestar en Tulum: sesiones diarias de yoga, ceremonia de temazcal, gastronomía orgánica de la granja a la mesa, meditación en cenote y relajación frente al mar.",
    },
    destination: "Tulum, Quintana Roo",
    hotel: "Azulik Tulum",
    priceMXN: 38000,
    adultRate: 38000,
    childRate: 19000,
    durationNights: 5,
    images: [
      "packages/tulum-wellness-5n/hero.jpg",
      "packages/tulum-wellness-5n/yoga.jpg",
      "packages/tulum-wellness-5n/temazcal.jpg",
    ],
    includes: {
      en: ["Treehouse suite", "Daily yoga & meditation", "Temazcal purification ceremony", "Organic meals included", "Cenote wellness experience"],
      es: ["Suite en casa del árbol", "Yoga y meditación diarios", "Ceremonia de purificación temazcal", "Comidas orgánicas incluidas", "Experiencia de bienestar en cenote"],
    },
    availability: { startDate: "2026-05-01", endDate: "2026-12-31", spotsTotal: 12, spotsRemaining: 12 },
  },
  {
    slug: "merida-yucatan-4n",
    name: { en: "Mérida & Yucatán Discovery", es: "Descubrimiento Mérida y Yucatán" },
    description: {
      en: "4 nights based in the White City: Chichén Itzá at sunrise, Uxmal ruins, cenote swimming, Celestún flamingo reserve, and Yucatecan cuisine.",
      es: "4 noches con base en la Ciudad Blanca: Chichén Itzá al amanecer, ruinas de Uxmal, nado en cenotes, reserva de flamingos de Celestún y cocina yucateca.",
    },
    destination: "Mérida, Yucatán",
    hotel: "Casa Lecanda Boutique Hotel",
    priceMXN: 16500,
    adultRate: 16500,
    childRate: 8250,
    durationNights: 4,
    images: [
      "packages/merida-yucatan-4n/hero.jpg",
      "packages/merida-yucatan-4n/chichen-itza.jpg",
      "packages/merida-yucatan-4n/flamingos.jpg",
    ],
    includes: {
      en: ["Boutique hotel in Centro", "Chichén Itzá sunrise tour", "Celestún flamingo boat ride", "Cenote swim & lunch", "Yucatecan cooking class"],
      es: ["Hotel boutique en Centro", "Tour al amanecer a Chichén Itzá", "Paseo en lancha por flamingos de Celestún", "Nado en cenote y almuerzo", "Clase de cocina yucateca"],
    },
    availability: { startDate: "2026-03-01", endDate: "2026-12-31", spotsTotal: 30, spotsRemaining: 30 },
  },
];

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

async function deleteCollection(collectionPath, batchSize = 100) {
  const collRef = db.collection(collectionPath);
  const snapshot = await collRef.limit(batchSize).get();
  if (snapshot.empty) return 0;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();

  const deleted = snapshot.size;
  if (deleted >= batchSize) {
    return deleted + (await deleteCollection(collectionPath, batchSize));
  }
  return deleted;
}

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

async function seed() {
  const env = process.env.FIRESTORE_EMULATOR_HOST ? "emulator" : "production";
  console.log(`\nVIDA Travel — Package Seeder (${env})`);
  console.log("=".repeat(50));

  if (isProduction && !process.argv.includes("--yes")) {
    console.log(
      "\nWARNING: You are about to write to PRODUCTION Firestore." +
        "\nRe-run with --yes to confirm, or set FIRESTORE_EMULATOR_HOST.\n"
    );
    process.exit(1);
  }

  if (shouldClean) {
    const deleted = await deleteCollection("packages");
    console.log(`Cleaned ${deleted} existing package(s).`);
  }

  const batch = db.batch();
  const now = admin.firestore.Timestamp.now();

  for (const pkg of packages) {
    const ref = db.collection("packages").doc(pkg.slug);
    batch.set(ref, {
      name: pkg.name,
      description: pkg.description,
      destination: pkg.destination,
      hotel: pkg.hotel,
      priceMXN: pkg.priceMXN,
      adultRate: pkg.adultRate,
      childRate: pkg.childRate,
      durationNights: pkg.durationNights,
      images: pkg.images,
      includes: pkg.includes,
      availability: {
        startDate: pkg.availability.startDate,
        endDate: pkg.availability.endDate,
        spotsTotal: pkg.availability.spotsTotal,
        spotsRemaining: pkg.availability.spotsRemaining,
      },
      active: true,
      createdAt: now,
      updatedAt: now,
    });
  }

  await batch.commit();
  console.log(`\nSeeded ${packages.length} packages:`);
  for (const pkg of packages) {
    console.log(
      `  [OK]  ${pkg.slug.padEnd(35)} $${pkg.priceMXN.toLocaleString()} MXN  (${pkg.durationNights}N)`
    );
  }

  /* Verify by reading back */
  const snapshot = await db.collection("packages").where("active", "==", true).get();
  console.log(`\nVerification: ${snapshot.size} active packages in Firestore.`);

  if (snapshot.size >= 10) {
    console.log("PASS: 10+ packages requirement met.\n");
  } else {
    console.log("FAIL: Fewer than 10 packages found.\n");
    process.exit(1);
  }
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
