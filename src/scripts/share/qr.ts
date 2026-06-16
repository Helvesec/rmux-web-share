import qrcodeFactory from 'qrcode-generator';

export function qrDataUrl(value: string): string {
  const qr = qrcodeFactory(0, 'M');
  qr.addData(value);
  qr.make();
  return qr.createDataURL(6, 2);
}
