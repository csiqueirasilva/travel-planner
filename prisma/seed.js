const { PrismaClient, Role } = require('@prisma/client');

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding travel planner data...');

  await prisma.usageLog.deleteMany();
  await prisma.review.deleteMany();
  await prisma.booking.deleteMany();
  await prisma.itinerary.deleteMany();
  await prisma.purchase.deleteMany();
  await prisma.offer.deleteMany();
  await prisma.roomType.deleteMany();
  await prisma.hotel.deleteMany();
  await prisma.plane.deleteMany();
  await prisma.location.deleteMany();
  await prisma.client.deleteMany();

  const admin = await prisma.client.create({
    data: {
      matricula: '0000001',
      name: 'Class Admin',
      email: 'admin@leiame.app',
      role: Role.ADMIN,
      active: true,
    },
  });

  const student = await prisma.client.create({
    data: {
      matricula: '1234567',
      name: 'Student User',
      email: 'student@leiame.app',
      role: Role.STUDENT,
      active: true,
    },
  });

  const [rio, saoPaulo, nyc] = await prisma.$transaction([
    prisma.location.create({
      data: { name: 'Rio de Janeiro', city: 'Rio de Janeiro', state: 'RJ', country: 'Brazil' },
    }),
    prisma.location.create({
      data: { name: 'São Paulo', city: 'São Paulo', state: 'SP', country: 'Brazil' },
    }),
    prisma.location.create({
      data: { name: 'New York', city: 'New York', state: 'NY', country: 'USA' },
    }),
  ]);

  const copacabana = await prisma.hotel.create({
    data: {
      name: 'Copacabana Palace',
      city: 'Rio de Janeiro',
      country: 'Brazil',
      address: 'Av. Atlântica, 1702',
      price: 950,
      stars: 5,
      amenities: ['wifi', 'pool', 'spa', 'gym'],
      locationId: rio.id,
      roomTypes: {
        create: [
          { name: 'Deluxe Ocean', price: 1200, available: 5 },
          { name: 'City View', price: 800, available: 10 },
        ],
      },
    },
  });

  const paulista = await prisma.hotel.create({
    data: {
      name: 'Paulista Comfort',
      city: 'São Paulo',
      country: 'Brazil',
      address: 'Av. Paulista, 900',
      price: 500,
      stars: 4,
      amenities: ['wifi', 'breakfast', 'gym'],
      locationId: saoPaulo.id,
      roomTypes: {
        create: [
          { name: 'Business', price: 550, available: 15 },
          { name: 'Suite', price: 750, available: 6 },
        ],
      },
    },
  });

  const centralPark = await prisma.hotel.create({
    data: {
      name: 'Central Park Hotel',
      city: 'New York',
      country: 'USA',
      address: '5th Avenue',
      price: 300,
      stars: 3,
      amenities: ['wifi', 'breakfast'],
      locationId: nyc.id,
      roomTypes: {
        create: [
          { name: 'Queen', price: 320, available: 12 },
          { name: 'Family', price: 450, available: 4 },
        ],
      },
    },
  });

  const [flight1, flight2, flight3] = await prisma.$transaction([
    prisma.plane.create({
      data: {
        code: 'G3-101',
        origin: 'RIO',
        destination: 'SAO',
        departure: new Date(Date.now() + 24 * 60 * 60 * 1000),
        arrival: new Date(Date.now() + 26 * 60 * 60 * 1000),
        price: 350,
      },
    }),
    prisma.plane.create({
      data: {
        code: 'LA-880',
        origin: 'SAO',
        destination: 'NYC',
        departure: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
        arrival: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000 + 10 * 60 * 60 * 1000),
        price: 1200,
      },
    }),
    prisma.plane.create({
      data: {
        code: 'UA-55',
        origin: 'NYC',
        destination: 'RIO',
        departure: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
        arrival: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000 + 9 * 60 * 60 * 1000),
        price: 980,
      },
    }),
  ]);

  await prisma.offer.createMany({
    data: [
      { title: 'Summer deal Rio', description: '15% off beach hotels', discountPercent: 15 },
      { title: 'Student flight sale', description: '10% off SAO -> NYC', discountPercent: 10 },
    ],
  });

  const purchase1 = await prisma.purchase.create({
    data: {
      clientMatricula: student.matricula,
      hotelId: copacabana.id,
      checkIn: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      checkOut: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
      totalAmount: 2400,
    },
  });

  const purchase2 = await prisma.purchase.create({
    data: {
      clientMatricula: student.matricula,
      planeId: flight1.id,
      totalAmount: 350,
    },
  });

  const itinerary = await prisma.itinerary.create({
    data: {
      name: 'NYC Conference',
      clientMatricula: student.matricula,
      notes: 'Hotel + flight combo',
    },
  });

  await prisma.booking.createMany({
    data: [
      {
        clientMatricula: student.matricula,
        hotelId: centralPark.id,
        itineraryId: itinerary.id,
        status: 'CONFIRMED',
        totalAmount: 900,
      },
      {
        clientMatricula: student.matricula,
        planeId: flight2.id,
        itineraryId: itinerary.id,
        status: 'CONFIRMED',
        totalAmount: 1200,
      },
    ],
  });

  await prisma.review.create({
    data: {
      hotelId: copacabana.id,
      clientMatricula: student.matricula,
      rating: 5,
      comment: 'Amazing stay, great breakfast.',
    },
  });

  await prisma.usageLog.create({
    data: {
      matricula: admin.matricula,
      method: 'POST',
      path: '/seed',
      status: 200,
    },
  });

  console.log('Seed complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
