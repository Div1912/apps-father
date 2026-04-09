const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
p.user.findMany({ select: { id: true, firstName: true, balance: true } })
  .then(users => {
    users.forEach(u => console.log(`User ${u.id} (${u.firstName}): $${u.balance}`));
    return p.$disconnect();
  });
