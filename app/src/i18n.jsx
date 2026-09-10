import React, { createContext, useContext, useCallback, useMemo, useState } from 'react';
/* eslint-disable react-refresh/only-export-components */

// Lightweight isiZulu/English localisation. Strings are flat keys with {var}
// interpolation; any key missing from isiZulu falls back to English, then to
// the key itself. The choice persists per device.

const LANG_KEY = 'drivelocal_lang';

const EN = {
  // Common
  'common.call': '📞 Call',
  'common.whatsapp': '💬 WhatsApp',
  'common.cancel': 'Cancel',
  'common.back': '‹ Back',
  'common.loading': 'Loading…',
  'common.driver': 'Driver',
  'common.phone': 'Phone number',
  'common.name': 'Name',
  'common.save': 'Save',
  'common.skip': 'Skip',
  'common.next': 'Next',
  'common.done': 'Done',

  // Landing
  'landing.tagline': "Thubelihle & Kriel's friendly local ride — book in seconds.",
  'landing.online': 'is online — book a ride now',
  'landing.offline': 'is offline right now — you can still schedule ahead',
  'landing.customer': 'Book a ride',
  'landing.driver': 'Driver sign-in',
  'landing.customerShort': 'Customer',
  'landing.driverShort': 'Driver',
  'landing.remember': 'Save my details',

  // Login
  'login.sendOtp': 'Send me the code',
  'login.verify': 'Verify & continue',
  'login.enterPhone': 'Enter your phone number to get a one-time code.',
  'login.enterOtp': "Type the code we just texted you.",
  'login.wrongPhoneHint': 'Driver phone: +27 00 000 0000',
  'login.customerHint': 'Any number can sign in as a customer',
  'login.driverHint': 'Only the registered driver phone can sign in here',
  'login.titleCustomer': 'Log in with your phone',
  'login.titleDriver': 'Driver login',
  'login.requestCode': 'Request code',
  'login.sending': 'Sending…',
  'login.verifying': 'Verifying…',
  'login.changePhone': 'Change phone number',
  'login.codeSent': 'Code sent to {phone}',
  'login.verificationCode': 'Verification code',
  'login.codePh': '6-digit code',
  'login.yourName': 'Your name (optional)',
  'login.email': 'Email (optional)',
  'login.ph': '+27 82 000 0000',
  'login.changeRole': '‹ Change (customer / driver)',
  'login.taglineCustomer': 'Your trusted local driver — book in seconds.',
  'login.taglineDriver': 'Driver login — manage trips and bookings.',
  'login.enterCode': 'Enter your code',
  'login.devHint': 'We text you a one-time code. In local development the code is also shown in the server console.',

  // Home
  'home.book': 'Book a ride',
  'home.savedPlaces': 'Saved places',
  'home.lastRide': 'Last ride',
  'home.bookAgain': 'Book again',
  'home.yourDriver': 'Your driver',
  'home.notFound': 'Driver not found',
  'home.rates': 'Base {base} · {perKm}/km',
  'home.base': 'Base',
  'home.onlineCheck': 'See if we are online by tapping “Book a ride”.',
  'home.callDriver': 'Call driver',
  'home.roundTrip': 'Round trip',
  'home.tapToBook': 'Tap “Book a ride” to add your home, work and regular spots.',

  // Book
  'book.title': 'Book a ride',
  'book.pickupLabel': 'Pickup — where the driver picks you up',
  'book.pickupPlaceholder': 'Tap 🎯 or the map to set pickup',
  'book.locating': 'Detecting location…',
  'book.destLabel': 'Destination — where you\'re going',
  'book.destPlaceholder': 'Tap the map to set your destination',
  'book.destRebook': 'Destination set — tap map fine to adjust',
  'book.estimate': 'estimate',
  'book.review': 'Review booking',
  'book.scheduleRide': 'Schedule ride',
  'book.payCash': '💵 Cash',
  'book.payCard': '💳 Card',
  'book.now': '⚡ Now',
  'book.schedule': '📅 Schedule',
  'book.setDest': 'Set a destination to see your fare',
  'book.calculating': 'Calculating fare…',
  'book.pickupNotePh': 'Describe how to find this spot (e.g. opposite the red shop, next to the big tree)…',
  'book.destNotePh': 'Describe the destination (e.g. the house with the white gate)…',
  'book.noStreets': 'No street names? No problem. Drop a pin and describe the spot so your driver can find it exactly.',

  // ActiveTrip
  'trip.requested': 'Booking requested',
  'trip.accepted': 'Driver on the way',
  'trip.ongoing': 'Trip in progress',
  'trip.completed': 'Trip complete',
  'trip.cancelled': 'Trip cancelled',
  'trip.cancel': 'Cancel ride',
  'trip.home': '‹ Home',
  'trip.waiting': 'Waiting for your driver to accept…',
  'trip.onWay': 'Your driver is on the way. Track their car approaching you.',
  'trip.here': '🛑 Your driver is here — look out for the car.',
  'trip.inProgress': 'Trip in progress — tracking in real time.',
  'trip.arrivingIn': 'Arriving in ≈ {min} min',
  'trip.tracking': 'Tracking driver…',
  'trip.driverArrived': 'Driver has arrived',
  'trip.share': '🔗 Share trip status',
  'trip.call': 'Call',
  'trip.cta': 'Confirm booking',
  'trip.fareDriver': 'Driver\'s final fare',
  'trip.confirmFare': 'Confirm final fare',
  'trip.confirmFareHint': 'Confirm the fare so you can rate & tip the driver.',
  'trip.rateTitle': 'How was your ride?',
  'trip.tipLabel': 'Add a tip',
  'trip.noTip': 'No tip',
  'trip.rateBtn': 'Rate & tip',
  'trip.bookAnother': 'Book another ride',
  'trip.thanksRated': 'Thanks! You rated {stars}★',
  'trip.dispute': '🤔 The fare doesn\'t seem right?',

  // History
  'history.title': 'Your rides',
  'history.empty': 'No rides yet — book your first ride!',
  'history.receipt': '🧾 DriveLocal receipt',
};

const ZU = {
  'common.call': '📞 Shayela',
  'common.whatsapp': '💬 WhatsApp',
  'common.cancel': 'Khansela',
  'common.back': '‹ Emuva',
  'common.loading': 'Kulayisha…',
  'common.driver': 'Umshayeli',
  'common.phone': 'Inombolo yocingo',
  'common.name': 'Igama',
  'common.save': 'Londoloza',

  'landing.tagline': 'Uhambo oluthile lwase-Thubelihle ne-Kriel — bhuka emizuzwaneni.',
  'landing.online': 'usemgwaqweni — bhuka uhambo manje',
  'landing.offline': 'akakho okwamanje — ungahlela uhambo lungakazi',
  'landing.customer': 'Bhuka uhambo',
  'landing.driver': 'Ngena njengo-mshayeli',
  'landing.customerShort': 'Ikhasimende',
  'landing.driverShort': 'Umshayeli',

  'login.sendOtp': 'Ngithumele ikhodi',
  'login.verify': 'Qinisekisa & qhubeka',
  'login.enterPhone': 'Faka inombolo yakho ukuze uthole ikhodi.',
  'login.enterOtp': 'Thayipha ikhodi esikuyithumelile nge-SMS.',
  'login.wrongPhoneHint': 'Unombolo yomshayeli: +27 00 000 0000',
  'login.customerHint': 'Noma iyiphi inombolo ingangena njengekhasimende',
  'login.driverHint': 'Inombolo yomshayeli kuphela engenela lapha',
  'login.titleCustomer': 'Ngena ngenombolo yakho',
  'login.titleDriver': 'Ukungena komshayeli',
  'login.requestCode': 'Cela ikhodi',
  'login.sending': 'Kuthumela…',
  'login.verifying': 'Kuyiqinisekisa…',
  'login.changePhone': 'Shintsha inombolo',
  'login.codeSent': 'Ikhodi ithunyelwe ku-{phone}',
  'login.verificationCode': 'Ikhodi yokungena',
  'login.codePh': 'Ikhodi yezinhlamvu ezi-6',
  'login.yourName': 'Igama lakho (ngokuzithandela)',
  'login.email': 'I-imeyili (ngokuzithandela)',
  'login.ph': '+27 82 000 0000',
  'login.changeRole': '‹ Shintsha (ikhasimende / umshayeli)',
  'login.taglineCustomer': 'Umshayeli wakho wethembekile — bhuka emizuzwaneni.',
  'login.taglineDriver': 'Ukungena komshayeli — lawula izikhathi zohambo.',
  'login.enterCode': 'Faka ikhodi yakho',
  'login.devHint': 'Sikuthumela ikhodi nge-SMS. Ekukhuthuleni ikhodi iboniswa futhi kwiserver.',

  'home.book': 'Bhuka uhambo',
  'home.savedPlaces': 'Izindawo ozilondoloze',
  'home.lastRide': 'Uhambo lokugcina',
  'home.bookAgain': 'Buka futhi',
  'home.yourDriver': 'Umshayeli wakho',
  'home.notFound': 'Umshayeli akatholakali',
  'home.rates': 'Base {base} · {perKm}/km',
  'home.base': 'Base',
  'home.onlineCheck': 'Bheka ukuthi si-uku-inthanethi yini ngokuthepha “Bhuka uhambo”.',
  'home.callDriver': 'Shayela umshayeli',
  'home.tapToBook': 'Thepha “Bhuka uhambo” ukuze ungeze ikhaya, umsebenzi nezinye izindawo.',

  'book.title': 'Buka uhambo',
  'book.pickupLabel': 'Indawo yokukha — lapho umshayeli ezokuthatha khona',
  'book.pickupPlaceholder': 'Thepha 🎯 noma imephu ukulahla iphini',
  'book.locating': 'Kutholakala indawo…',
  'book.destLabel': 'Lapho uya khona — indawo yokufika',
  'book.destPlaceholder': 'Thepha imephu ukuze ubeke indawo yokufika',
  'book.destRebook': 'Indawo isibekiwe — thepha imephu ukuyilungisa',
  'book.estimate': 'isilinganiso',
  'book.review': 'Buka ukubukwa',
  'book.scheduleRide': 'Hlela uhambo',
  'book.payCash': '💵 Imali esikhwameni',
  'book.payCard': '💳 Ikhadini',
  'book.now': '⚡ Manje',
  'book.schedule': '📅 Hlela',
  'book.setDest': 'Beka indawo yokufika ukuze ubone malini izokhokha',
  'book.calculating': 'Kubalwa imali…',
  'book.pickupNotePh': 'Chaza indlela yokuthola le ndawo (isb. maqondana neshopu ebomvu, eduze kwesihlahla)…',
  'book.destNotePh': 'Chaza indawo yokufika (isb. indlu enesango elimhlophe)…',
  'book.noStreets': 'Azikho izitaladi? Kulungile. Lahla iphini bese uchaza indawo ukuze umshayeli ayithole kuyo kahle.',

  'trip.requested': 'Uhambo luyabalelwa',
  'trip.accepted': 'Umshayeli usemgwaqweni',
  'trip.ongoing': 'Uhambo luyaqhubeka',
  'trip.completed': 'Uhambo luphelile',
  'trip.cancelled': 'Uhambo lukhanseliwe',
  'trip.cancel': 'Khansela uhambo',
  'trip.home': '‹ Ikhaya',
  'trip.waiting': 'Linda umshayeli ukuthi amukele…',
  'trip.onWay': 'Umshayeli usemgwaqweni. Landela imoto yakhe isiza.',
  'trip.here': '🛑 Umshayeli usefikile — bheka imoto.',
  'trip.inProgress': 'Uhambo luyaqhubeka — siyalandelela.',
  'trip.arrivingIn': 'Ufika cishe ngemizuzu {min}',
  'trip.tracking': 'Siyalandelela umshayeli…',
  'trip.driverArrived': 'Umshayeli usefikile',
  'trip.share': '🔗 Yabelana ngesimo sohambo',
  'trip.call': 'Shayela',
  'trip.cta': 'Qinisekisa ukubhuka',
  'trip.fareDriver': 'Imali yokugcina yomshayeli',
  'trip.confirmFare': 'Qinisekisa imali yokugcina',
  'trip.confirmFareHint': 'Qinisekisa imali ukuze ukwazi ukuklama nokunikezela ithiphu.',
  'trip.rateTitle': 'Uhambo lube njani?',
  'trip.tipLabel': 'Engeza ithiphu',
  'trip.noTip': 'Ayikho ithiphu',
  'trip.rateBtn': 'Klelu & ithiphu',
  'trip.bookAnother': 'Buka elinye uhambo',
  'trip.thanksRated': 'Siyabonga! Uklame {stars}★',
  'trip.dispute': '🤔 Imali ayivumelani?',

  'history.title': 'Izikhathi ohambo',
  'history.empty': 'Akukho khambo okwamanje — buku elakho lokuqala!',
  'history.receipt': '🧾 Iresi ye-DriveLocal',
};

const DICTS = { en: EN, zu: ZU };

const LangContext = createContext({ lang: 'en', setLang: () => {}, t: (k) => k });

function savedLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return v === 'zu' ? 'zu' : 'en';
  } catch { return 'en'; }
}

export function LangProvider({ children }) {
  const [lang, setLangState] = useState(savedLang);

  const setLang = (l) => {
    const next = l === 'zu' ? 'zu' : 'en';
    try { localStorage.setItem(LANG_KEY, next); } catch { /* ignore */ }
    setLangState(next);
  };

  const t = useCallback((key, vars = {}) => {
    let str = DICTS[lang]?.[key] ?? EN[key] ?? key;
    for (const [k, v] of Object.entries(vars)) {
      str = str.replaceAll(`{${k}}`, String(v));
    }
    return str;
  }, [lang]);

  const value = useMemo(() => ({ lang, setLang, t }), [lang, t]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

export function useI18n() {
  return useContext(LangContext);
}

export function LangToggle({ className = '' }) {
  const { lang, setLang } = useI18n();
  return (
    <button
      type="button"
      className={className || 'lang-toggle'}
      onClick={() => setLang(lang === 'en' ? 'zu' : 'en')}
      title="Language / Ulimi"
    >
      {lang === 'en' ? 'isiZulu' : 'English'}
    </button>
  );
}

export default EN;