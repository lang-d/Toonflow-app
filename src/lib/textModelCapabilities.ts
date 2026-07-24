export function shouldForwardTemperature(model: { supportsTemperature?: boolean } | undefined, temperature: unknown): boolean {
  return Boolean(temperature) && model?.supportsTemperature !== false;
}
