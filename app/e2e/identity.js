// Seed a customer's identity documents (the booking gate) through the real
// API — the same multipart shape as the Book screen's verify panel. Specs that
// merely need the gate out of the way call this right after login; the UI
// itself is exercised by the verify test in smoke.spec.js.
export async function uploadIdentity(page) {
  const result = await page.evaluate(async () => {
    const fd = new FormData();
    fd.append('idNumber', '9001015800088');
    fd.append('idCopy', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' }), 'id.jpg');
    fd.append('selfie', new Blob([new Uint8Array([4, 5, 6])], { type: 'image/jpeg' }), 'selfie.jpg');
    const res = await fetch('/api/customer/identity', {
      method: 'POST',
      headers: { Authorization: `Bearer ${localStorage.getItem('drivelocal_token')}` },
      body: fd,
    });
    return { status: res.status, body: await res.json().catch(() => ({})) };
  });
  if (result.status !== 201 && result.status !== 200) {
    throw new Error(`identity seed failed (${result.status}): ${result.body.error || 'unknown error'}`);
  }
  return result.body;
}
