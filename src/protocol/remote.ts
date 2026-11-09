/** A GitHub repo named by a git remote. */
export interface RemoteRepo {
  /** Lowercase, without port. */
  host: string;
  /** owner/repo. */
  repo: string;
}

/** Host and owner/repo of a git remote URL (HTTPS, ssh:// or SCP-style). */
export function parseRepoIdentity(remote: string): RemoteRepo {
  let host: string;
  let path: string;
  const scp = remote.match(/^[^/@\s]+@([^/:\s]+):(.*)$/);
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    // scheme://[userinfo@]host[:port]/path, without query or fragment.
    const url = remote.match(
      /^(?:https?|ssh):\/\/(?:[^/@\s]*@)?([^/:@\s]+)(?::\d+)?\/([^?#\s]*)$/i,
    );
    if (!url) throw new Error("Unsupported origin remote URL");
    host = url[1] ?? "";
    path = url[2] ?? "";
  }
  host = host.toLowerCase();
  // GitHub's SSH-over-443 endpoint is still github.com for the API and gh.
  if (host === "ssh.github.com") host = "github.com";
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host))
    throw new Error("Origin remote has no valid host");
  path = path.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path))
    throw new Error("Origin remote must identify owner/repo");
  const [owner, repo] = path.split("/");
  if (owner === "." || owner === ".." || repo === "." || repo === "..")
    throw new Error("Invalid origin repository");
  return { host, repo: path };
}
