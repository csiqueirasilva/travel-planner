/* Populate flights for the next two years and bump hotel room availability.
   - Inserts ~10 flights per day per route
   - Routes cover major seed cities (RIO, SAO, NYC) in both directions
   - RoomTypes are set to at least 100 available
*/
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const ROUTES = [
  { origin: 'RIO', destination: 'SAO', base: 'RS', durationHours: 1.5, basePrice: 350 },
  { origin: 'SAO', destination: 'RIO', base: 'SR', durationHours: 1.5, basePrice: 350 },
  { origin: 'SAO', destination: 'NYC', base: 'SN', durationHours: 10, basePrice: 1200 },
  { origin: 'NYC', destination: 'SAO', base: 'NS', durationHours: 10, basePrice: 1200 },
  { origin: 'RIO', destination: 'NYC', base: 'RN', durationHours: 9, basePrice: 980 },
  { origin: 'NYC', destination: 'RIO', base: 'NR', durationHours: 9, basePrice: 980 },
];

const FLIGHTS_PER_DAY = 10;
const DAYS_AHEAD = 365 * 2;
const RUN_ID = Date.now().toString(36);

function addDaysUTC(date, days) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

async function main() {
  console.log('Bumping room availability to 100...');
  await prisma.roomType.updateMany({ data: { available: 100 } });

  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const batch = [];

  for (let day = 0; day < DAYS_AHEAD; day++) {
    const dayStart = addDaysUTC(start, day);
    for (const route of ROUTES) {
      for (let slot = 0; slot < FLIGHTS_PER_DAY; slot++) {
        const dep = new Date(dayStart);
        dep.setUTCHours(6 + slot * 2, 0, 0, 0);
        const arr = new Date(dep.getTime() + route.durationHours * 60 * 60 * 1000);
        const code = `${route.base}${String(day + 1).padStart(3, '0')}${slot}${RUN_ID}`.slice(0, 10);
        const price = route.basePrice + slot * 20 + Math.floor(Math.random() * 50);
        batch.push({
          code,
          origin: route.origin,
          destination: route.destination,
          departure: dep,
          arrival: arr,
          price,
        });
      }
    }
  }

  console.log(`Prepared ${batch.length} flights. Inserting in chunks...`);
  const CHUNK = 2000;
  for (let i = 0; i < batch.length; i += CHUNK) {
    const slice = batch.slice(i, i + CHUNK);
    await prisma.plane.createMany({ data: slice });
    console.log(`Inserted ${Math.min(i + CHUNK, batch.length)}/${batch.length}`);
  }

  console.log('Done.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
