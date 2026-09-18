// Seeds a demo Driver account plus a demo Customer, with South African rates.
const repo = require('../db/repository');
const config = require('../config');

function main() {
  // Default the seeded driver to the platform owner (DRIVER_PHONE) so a fresh
  // production deploy ends up with a usable admin account and driver profile.
  // Override with SEED_DRIVER_PHONE if you want demo accounts instead.
  const adminPhone = process.env.SEED_DRIVER_PHONE || config.driverPhone;
  const customerPhone = process.env.SEED_CUSTOMER_PHONE || '+27730002222';
  const isProd = config.nodeEnv === 'production';

  // The admin/owner phone may already exist as a customer (single phone/row model).
  let driver = repo.getUserByPhone(adminPhone, undefined);
  if (!driver) {
    driver = repo.createUser({
      phone: adminPhone,
      name: 'Thabo Driver',
      email: 'driver@drivelocal.co.za',
      role: 'admin',
      driverStatus: 'approved',
    });
  } else if (driver.role !== 'admin') {
    repo.promoteToAdmin(driver.id);
    driver = repo.updateUserProfile(driver.id, {
      name: driver.name || 'Thabo Driver',
      email: driver.email || 'driver@drivelocal.co.za',
    });
  }
  // Only fill in default profile fields when they're empty — never overwrite a
  // driver's real vehicle/rates after they've set them in the Profile screen.
  if (!driver.vehicle_type) {
    driver = repo.updateUserProfile(driver.id, {
      vehicle_type: 'Chevrolet Spark LT',
      license_plate: 'XX 000 XX',
      base_fare: 25,
      per_km_rate: 12,
      per_min_rate: 2.5,
      service_radius_km: 50,
    });
  }
  repo.createWalletIfMissing(driver.id);
  console.log(`Driver ready: ${adminPhone} (${driver.role})`);

  // Skip the demo customer/console demo in production — only the owner-driver
  // account is wanted on a live deploy.
  if (isProd && !process.env.SEED_CUSTOMER_PHONE) {
    console.log('Skipping demo customer (production).');
  } else {
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
  }

  const location = repo.getDriverLocation(driver.id);
  if (!location) {
    // Default driver start position: Thubelihle, Kriel (Mpumalanga) — the app's
    // service area. Kept here so bookings in the area pass the service check.
    repo.upsertDriverLocation(driver.id, { lat: -26.2155, lng: 29.2916, heading: 0, accuracy: 15 });
    console.log('Driver location seeded near Thubelihle, Kriel.');
  }

  console.log('\nSeeded demo accounts:');
  console.log(`  Driver   -> ${adminPhone} (passwordless, OTP by SMS / console in dev)`);
  console.log(`  Customer -> ${customerPhone}`);
  console.log('\nRates: base R25.00, R12.00/km, R2.50/min, currency ZAR.');
}

main();
