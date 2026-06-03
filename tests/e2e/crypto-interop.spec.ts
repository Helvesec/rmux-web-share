import { expect, test } from '@playwright/test';

test('browser token derivation matches the daemon vector', async ({ page }) => {
  await page.goto('/');

  const vector = await page.evaluate(async () => {
    const { deriveSpectatorToken, tokenIdForToken } = await import('/src/scripts/share/e2ee.ts');
    const token = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
    const spectatorToken = await deriveSpectatorToken(token);

    async function sha256Hex(text: string): Promise<string> {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
      return hex(new Uint8Array(digest));
    }

    function hex(bytes: Uint8Array): string {
      return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    }

    return {
      psk: await sha256Hex(token),
      tokenId: await tokenIdForToken(token),
      spectatorToken,
      spectatorPsk: await sha256Hex(spectatorToken),
      spectatorTokenId: await tokenIdForToken(spectatorToken),
    };
  });

  expect(vector).toEqual({
    psk: 'ea866a757e4c38babfa8127cbe9a409d3e1f93a00ff1488ff735fcf917afffd0',
    tokenId: 'VANRFV6FYQX1QTOi-BMVrQ',
    spectatorToken: 'f-dj7QKyPUJhAZabQ7IkQCRR1DoYQvIGf-OkgSGMuo4',
    spectatorPsk: '107f3721f4b437db5c5e8107727565c2697b3af2a159fd6f35281b13dcd8b62a',
    spectatorTokenId: 'PhCBAZMZcF4zzFOwp0GBjA',
  });
});

test('browser WASM seals the canonical auth frame byte-for-byte', async ({ page }) => {
  await page.goto('/');

  const frameHex = await page.evaluate(async () => {
    const wasm = await import('/src/scripts/share/wasm-test/rmux_web_crypto_wasm.js');
    await wasm.default();

    const psk = new TextEncoder().encode('interop-v1-token-psk');
    const dh = new Uint8Array(32).fill(0x24);
    const mlKem = new Uint8Array(32).fill(0x42);
    const clientHello = new TextEncoder().encode(
      '{"type":"hello","protocol_version":1,"capabilities":["e2ee-token-auth"],"token_id":"tok","client_nonce":"nonce","client_public":"pub","client_ml_kem_ek":"ek"}',
    );
    const serverChallenge = new TextEncoder().encode(
      '{"type":"challenge","protocol_version":1,"capabilities":["e2ee-token-auth"],"server_nonce":"nonce","server_public":"pub","server_ml_kem_ct":"ct"}',
    );
    const auth =
      '{"type":"auth","protocol_version":1,"capabilities":["e2ee-token-auth"],"pin":"482917"}';

    const session = new wasm.ClientSession(psk, dh, mlKem, clientHello, serverChallenge);
    const frame = session.sealText(auth);
    session.free();

    return Array.from(frame, (byte) => byte.toString(16).padStart(2, '0')).join('');
  });

  expect(frameHex).toBe(
    'e00000000000000000d5511391a56ab7c68bcec1b0482717a2c24741dc13ea174be4a3bc851eab870629b98e2894629041b5d9a7b5fe7dd29456f5c59ed31e69a26bf44be676c60c1efa8405786b13a17e870b62e23ba2d0c2f488ce753e9ce25fb10f85d1c6fdedf5eea2d652643c45',
  );
});
