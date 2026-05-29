import { shareAssetUrl, shareBaseUrl } from './fragment';

const PROVENANCE_PATH = '.well-known/rmux-web-share.json';

export function provenanceDialogTemplate(): string {
  return `
    <dialog class="share-provenance" data-share-provenance>
      <form method="dialog" class="share-provenance-panel">
        <h1>Security & provenance</h1>
        <p data-share-provenance-statement>
          share.rmux.io serves only the static frontend and does not relay terminal data. Terminal frames are end-to-end encrypted, the token stays in the URL fragment, the source is public, builds are verifiable, deployments are traceable, and the frontend can be self-hosted.
        </p>
        <dl class="share-provenance-list">
          <div>
            <dt>GitHub SHA-1</dt>
            <dd><a data-share-provenance-commit href="https://github.com/Helvesec/rmux-web-share" target="_blank" rel="noopener noreferrer">loading</a></dd>
          </div>
          <div>
            <dt>Build run</dt>
            <dd><a data-share-provenance-run href="https://github.com/Helvesec/rmux-web-share/actions" target="_blank" rel="noopener noreferrer">loading</a></dd>
          </div>
          <div>
            <dt>Cloudflare</dt>
            <dd><a data-share-provenance-cloudflare href="https://github.com/Helvesec/rmux-web-share/actions" target="_blank" rel="noopener noreferrer">deployment proof</a></dd>
          </div>
          <div>
            <dt>Asset hashes</dt>
            <dd><a href="${shareAssetUrl('checksums.txt')}" target="_blank" rel="noopener noreferrer">checksums.txt</a></dd>
          </div>
        </dl>
        <div class="share-confirm-actions">
          <button type="submit">Close</button>
        </div>
      </form>
    </dialog>
  `;
}

export class ProvenanceDialog {
  private readonly dialog: HTMLDialogElement;
  private readonly commit: HTMLAnchorElement;
  private readonly run: HTMLAnchorElement;
  private readonly cloudflare: HTMLAnchorElement;
  private readonly statement: HTMLElement;

  constructor(root: ParentNode) {
    this.dialog = query(root, '[data-share-provenance]');
    this.commit = query(root, '[data-share-provenance-commit]');
    this.run = query(root, '[data-share-provenance-run]');
    this.cloudflare = query(root, '[data-share-provenance-cloudflare]');
    this.statement = query(root, '[data-share-provenance-statement]');
  }

  bind(trigger: HTMLElement): void {
    trigger.addEventListener('click', () => {
      void this.open();
    });
  }

  async open(): Promise<void> {
    if (!this.dialog.open) {
      this.dialog.showModal();
    }
    try {
      const provenanceUrl = new URL(PROVENANCE_PATH, shareBaseUrl()).toString();
      const response = await fetch(provenanceUrl, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error(`failed to fetch ${provenanceUrl}`);
      }
      this.set(await response.json() as BuildProvenance);
    } catch {
      this.statement.textContent = 'Build provenance is unavailable for this deployment.';
      setProofLink(this.commit, 'Repository', 'https://github.com/Helvesec/rmux-web-share');
      setProofLink(this.run, 'Actions', 'https://github.com/Helvesec/rmux-web-share/actions');
      setProofLink(this.cloudflare, 'Cloudflare proof in Actions', 'https://github.com/Helvesec/rmux-web-share/actions');
    }
  }

  private set(provenance: BuildProvenance): void {
    this.statement.textContent = provenance.security_statement;
    setProofLink(
      this.commit,
      shortSha(provenance.commit_sha1),
      provenance.commit_url ?? provenance.repository,
    );
    setProofLink(
      this.run,
      provenance.github_actions.run_id ? `run ${provenance.github_actions.run_id}` : 'Actions',
      provenance.github_actions.run_url ?? `${provenance.repository}/actions`,
    );
    setProofLink(
      this.cloudflare,
      provenance.cloudflare_pages.project,
      provenance.cloudflare_pages.deployment_proof,
    );
  }
}

interface BuildProvenance {
  repository: string;
  commit_sha1: string | null;
  commit_url: string | null;
  security_statement: string;
  github_actions: {
    run_id: string | null;
    run_url: string | null;
  };
  cloudflare_pages: {
    project: string;
    deployment_proof: string;
  };
}

function query<T extends Element>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`missing provenance element ${selector}`);
  }
  return element;
}

function setProofLink(link: HTMLAnchorElement, label: string, href: string): void {
  link.textContent = label;
  link.href = href;
}

function shortSha(value: string | null): string {
  return value ? value.slice(0, 12) : 'unavailable';
}
