import { Link } from "../routing/Router";

interface BrandProps {
  readonly compact?: boolean;
}

export function Brand({ compact = false }: BrandProps): React.JSX.Element {
  return (
    <Link className="brand" to="/" aria-label="RafayPair home">
      <span className="brand-mark" aria-hidden="true">
        R
      </span>
      {!compact && (
        <span className="brand-name">
          Rafay<span>Pair</span>
        </span>
      )}
    </Link>
  );
}
