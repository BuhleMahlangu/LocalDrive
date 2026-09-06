// Seeds a demo Driver account plus a demo Customer, with South African rates.
const repo = require('../db/repository');

function main() {
  const driverPhone = process.env.SEED_DRIVER_PHONE || '+27000000000';
  const customerPhone = process.env.SEED_CUSTOMER_PHONE || '+27730002222';

  // The driver phone may already exist as a customer (single phone/row model).
  let driver = repo.getUserByPhone(driverPhone, undefined);
  if (!driver) {
    driver = repo.createUser({
      phone: driverPhone,
      name: 'Thabo Driver',
      email: 'driver@drivelocal.co.za',
      role: 'driver',
    });
  } else if (driver.role !== 'driver') {
    repo.promoteToDriver(driver.id);
    driver = repo.updateUserProfile(driver.id, {
      name: driver.name || 'Thabo Driver',
      email: driver.email || 'driver@drivelocal.co.za',
    });
  }
  driver = repo.updateUserProfile(driver.id, {
    vehicle_type: 'Chevrolet Spark LT',
    license_plate: 'XX 000 XX',
    base_fare: 25,
    per_km_rate: 12,
    per_min_rate: 2.5,
    service_radius_km: 50,
  });
  console.log(`Driver ready: ${driverPhone} (${driver.role})`);

  let customer = repo.getUserByPhone(customerPhone, 'customer');
  if (!customer) {
    customer = repo.createUser({
      phone: customerPhone,
      name: 'Naledi Customer',
      email: 'customer@example.co.za',
      role: 'customer',
    });
    console.log(`Customer created: ${customerPhone}`);
  } else {
    console.log(`Customer already exists: ${customerPhone}`);
  }

  const location = repo.getDriverLocation(driver.id);
  if (!location) {
    // Default driver start position: Thubelihle, Kriel (Mpumalanga) — the app's
    // service area. Kept here so bookings in the area pass the service check.
    repo.upsertDriverLocation(driver.id, { lat: -26.2155, lng: 29.2916, heading: 0, accuracy: 15 });
    console.log('Driver location seeded near Thubelihle, Kriel.');
  }

  console.log('\nSeeded demo accounts:');
  console.log(`  Driver   -> ${driverPhone} (passwordless, OTP by SMS / console in dev)`);
  console.log(`  Customer -> ${customerPhone}`);
  console.log('\nRates: base R25.00, R12.00/km, R2.50/min, currency ZAR.');
}

main();
