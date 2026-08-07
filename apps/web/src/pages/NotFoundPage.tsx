import { Link } from "../routing/Router";

export function NotFoundPage(): React.JSX.Element {
  return (
    <div className="empty-state not-found">
      <p className="eyebrow">Page not found</p>
      <h1>This path is outside your pair.</h1>
      <p>Return to your private RafayPair home.</p>
      <Link className="button" to="/">
        Go home
      </Link>
    </div>
  );
}
