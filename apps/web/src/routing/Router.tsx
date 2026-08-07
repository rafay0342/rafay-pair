import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

interface RouterValue {
  readonly pathname: string;
  readonly navigate: (to: string, replace?: boolean) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

interface RouterProps {
  readonly children: ReactNode;
}

export function BrowserRouter({ children }: RouterProps): React.JSX.Element {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const handlePopState = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((to: string, replace = false): void => {
    const destination = resolveSameOriginPath(to, window.location.origin);
    if (replace) window.history.replaceState(null, "", destination);
    else window.history.pushState(null, "", destination);
    setPathname(window.location.pathname);
    window.scrollTo({ top: 0, behavior: "instant" });
  }, []);

  const value = useMemo(() => ({ pathname, navigate }), [navigate, pathname]);
  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

interface MemoryRouterProps extends RouterProps {
  readonly initialPath?: string;
}

export function MemoryRouter({
  children,
  initialPath = "/",
}: MemoryRouterProps): React.JSX.Element {
  const [pathname, setPathname] = useState(
    () =>
      new URL(
        resolveSameOriginPath(initialPath, "https://rafaypair.test"),
        "https://rafaypair.test",
      ).pathname,
  );
  const navigate = useCallback((to: string): void => {
    setPathname(
      new URL(
        resolveSameOriginPath(to, "https://rafaypair.test"),
        "https://rafaypair.test",
      ).pathname,
    );
  }, []);
  const value = useMemo(() => ({ pathname, navigate }), [navigate, pathname]);
  return (
    <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
  );
}

interface LinkProps extends Omit<
  AnchorHTMLAttributes<HTMLAnchorElement>,
  "href"
> {
  readonly to: string;
  readonly replace?: boolean;
}

export function Link({
  to,
  replace = false,
  onClick,
  target,
  children,
  ...props
}: LinkProps): React.JSX.Element {
  const { navigate } = useRouter();
  const href = resolveSameOriginPath(to, window.location.origin);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>): void => {
    onClick?.(event);
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (target && target !== "_self")
    ) {
      return;
    }
    event.preventDefault();
    navigate(to, replace);
  };
  return (
    <a {...props} href={href} target={target} onClick={handleClick}>
      {children}
    </a>
  );
}

interface NavLinkProps extends LinkProps {
  readonly end?: boolean;
}

export function NavLink({
  to,
  end = false,
  className,
  ...props
}: NavLinkProps): React.JSX.Element {
  const { pathname } = useRouter();
  const active = end
    ? pathname === to
    : pathname === to || pathname.startsWith(`${to}/`);
  const classes = [className, active ? "active" : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <Link
      {...props}
      to={to}
      className={classes || undefined}
      aria-current={active ? "page" : undefined}
    />
  );
}

export function Navigate({
  to,
  replace = false,
}: Pick<LinkProps, "to" | "replace">): null {
  const { navigate } = useRouter();
  useEffect(() => navigate(to, replace), [navigate, replace, to]);
  return null;
}

export function usePathname(): string {
  return useRouter().pathname;
}

function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error("Router component is missing");
  return value;
}

export function resolveSameOriginPath(to: string, origin: string): string {
  if (!to.startsWith("/") || to.startsWith("//")) {
    throw new Error("Navigation path must be an absolute same-origin path");
  }
  const destination = new URL(to, origin);
  if (destination.origin !== origin) {
    throw new Error("Cross-origin navigation is not allowed");
  }
  return `${destination.pathname}${destination.search}${destination.hash}`;
}
