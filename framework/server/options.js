export function listenPort(environment) {
  const text = environment.RIVETIN_LISTEN_PORT ?? '8787';
  if (!/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) throw new Error('INVALID_LISTEN_PORT');
  return Number(text);
}
