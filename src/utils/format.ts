import { MIST_PER_SUI } from '../constants';

export function formatSui(mist: number): string {
  return (mist / MIST_PER_SUI).toFixed(6);
}

// decode base64 to bytes (e.g. sponsored tx bytes from API)
export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// encode bytes to base64 for raw simulation display
export function bytesToBase64(bytes: Uint8Array): string {
  const chunk = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)));
  }
  return btoa(binary);
}

// from "0xPACKAGE::module::Type" return "module::Type"; plain addresses get shortened
export function shortLabelFromType(typeOrAddress: string): string {
  const idx = typeOrAddress.indexOf('::');
  if (idx !== -1) return typeOrAddress.slice(idx + 2);
  return shortenAddress(typeOrAddress);
}

export function shortenAddress(addr: string, head = 6, tail = 4): string {
  if (addr.length <= head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

// if label has an object address in angle brackets (e.g. <0x...>), shorten that address
export function labelWithShortenedAddresses(label: string): string {
  return label.replace(/<([0x][a-fA-F0-9]+)>/g, (_, addr) => `<${shortenAddress(addr)}>`);
}

// shorten any long 0x address (20+ hex chars) in a type/label string
export function shortenAddressesInType(str: string, shortenAddrFn: (a: string) => string = shortenAddress): string {
  return str.replace(/0x[a-fA-F0-9]{20,}/g, (match) => shortenAddrFn(match));
}
