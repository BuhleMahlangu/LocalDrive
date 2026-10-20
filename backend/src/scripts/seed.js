// Creates the platform owner (admin driver) account so a fresh deploy has a
// usable admin login. The owner then fills in their real name, vehicle and
// rates from the Profile screen. No demo accounts or rates are created.
const repo = require('../db/repository');
const config = require('../config');

function main() {
  // The owner is the platform admin (DRIVER_PHONE). Override with
  // SEED_DRIVER_PHONE only if you deliberately want a different seed account.
  const adminPhone = process.env.SEED_DRIVER_PHONE || config.driverPhone;
  // An optional demo/companion customer, created only when explicitly requested.
  const customerPhone = process.env.SEED_CUSTOMER_PHONE || null;

  // The admin/owner phone may already exist as a customer (single phone/row model).
  let driver = repo.getUserByPhone(adminPhone, undefined);
  if (!driver) {
    driver = repo.createUser({
      phone: adminPhone,
      name: '',
      email: '',
      role: 'admin',
      driverStatus: 'approved',
    });
  } else if (driver.role !== 'admin') {
    repo.promoteToAdmin(driver.id);
    driver = repo.updateUserProfile(driver.id, {
      name: driver.name || '',
      email: driver.email || '',
    });
  }
  // Leave vehicle/rates empty for the owner to set in the Profile screen — the
  // estimate engine falls back to platform defaults until they do.
  repo.createWalletIfMissing(driver.id);
  console.log(`Owner ready: ${adminPhone} (${driver.role})`);

  // Only create a customer when one is explicitly requested via SEED_CUSTOMER_PHONE.
  if (!customerPhone) {
    console.log('No customer seeded (set SEED_CUSTOMER_PHONE to create one).');
  } else {
    let customer = repo.getUserByPhone(customerPhone, 'customer');
    if (!customer) {
      customer = repo.createUser({
        phone: customerPhone,
        name: '',
        email: '',
        role: 'customer',
      });
      console.log(`Customer created: ${customerPhone}`);
    } else {
      console.log(`Customer already exists: ${customerPhone}`);
    }
  }

  const location = repo.getDriverLocation(driver.id);
  if (!location) {
    // Seed the driver's start position from the configured service area so the
    // first booking inside the area passes the service check. Skipped when the
    // owner hasn't set an area yet — the driver's real GPS takes over the moment
    // they go online.
    const area = repo.getServiceArea();
    if (area.lat != null && area.lng != null) {
      repo.upsertDriverLocation(driver.id, { lat: area.lat, lng: area.lng, heading: 0, accuracy: 15 });
      console.log(`Driver location seeded at the service area${area.name ? ` (${area.name})` : ''}.`);
    } else {
      console.log('No service area configured — driver location will come from GPS.');
    }
  }

  console.log('\nSeed complete:');
  console.log(`  Owner -> ${adminPhone} (passwordless, OTP by SMS / console in dev)`);
  if (customerPhone) console.log(`  Customer -> ${customerPhone}`);
  console.log('Set your name, vehicle and rates in the driver Profile screen.');
}

main();
