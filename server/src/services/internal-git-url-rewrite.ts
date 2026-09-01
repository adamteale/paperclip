/**
 * Rewrite internal Gitea origins in human-visible text to the public origin.
 *
 * On ASUS, agents post http://192.168.100.92:3002/... (GITEA_URL) or even
 * https://192.168.100.92:3002/... (improvised scheme) links that only resolve
 * inside the LAN — and https against the plain-HTTP port throws
 * ERR_SSL_PROTOCOL_ERROR even locally. GITEA_PUBLIC_URL
 * (https://robotpants.ddns.net:9443) is the internet-facing origin.
 *
 * Matching is scheme-agnostic (host:port), because agents routinely upgrade
 * the internal http origin to https when composing links by hand.
 *
 * GitHub/Bitbucket URLs never carry the internal origin and pass through
 * untouched. No-op when GITEA_URL or GITEA_PUBLIC_URL is unset or identical.
 */
export function rewriteInternalGitUrlsForHumans(body: string): string {
  const trimTrailingSlash = (value: string) => value.replace(/\/+$/, "");
  const internal = trimTrailingSlash(process.env.GITEA_URL?.trim() ?? "");
  const publicOrigin = trimTrailingSlash(process.env.GITEA_PUBLIC_URL?.trim() ?? "");
  if (!internal || !publicOrigin || internal === publicOrigin) return body;
  const hostPort = internal.replace(/^https?:\/\//, "");
  if (!hostPort) return body;
  return body
    .split(`http://${hostPort}`).join(publicOrigin)
    .split(`https://${hostPort}`).join(publicOrigin);
}