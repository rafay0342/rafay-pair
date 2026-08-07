import { AppShell } from "./components/AppShell";
import { PageSpinner } from "./components/Feedback";
import { AuthPage } from "./pages/AuthPage";
import { CapabilitiesPage } from "./pages/CapabilitiesPage";
import { CarePage } from "./pages/CarePage";
import { ConsentPage } from "./pages/ConsentPage";
import { HomePage } from "./pages/HomePage";
import { MovePage } from "./pages/MovePage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { PairPage } from "./pages/PairPage";
import { PrivacyPage } from "./pages/PrivacyPage";
import { Navigate, usePathname } from "./routing/Router";
import { useAuth } from "./state/AuthContext";
import { PairProvider } from "./state/PairContext";

export function App(): React.JSX.Element {
  const { status } = useAuth();
  const pathname = usePathname();

  if (status === "loading") {
    return (
      <main className="startup-screen">
        <div className="brand-mark" aria-hidden="true">
          R
        </div>
        <PageSpinner label="Opening RafayPair securely…" />
      </main>
    );
  }

  if (status === "anonymous") {
    return <AuthPage />;
  }

  const page = route(pathname);

  return (
    <PairProvider>
      <AppShell>{page}</AppShell>
    </PairProvider>
  );
}

function route(pathname: string): React.JSX.Element {
  switch (pathname) {
    case "/":
      return <HomePage />;
    case "/care":
      return <CarePage />;
    case "/move":
      return <MovePage />;
    case "/pair":
      return <PairPage />;
    case "/consent":
      return <ConsentPage />;
    case "/privacy":
      return <PrivacyPage />;
    case "/capabilities":
      return <CapabilitiesPage />;
    case "/404":
      return <NotFoundPage />;
    default:
      return <Navigate to="/404" replace />;
  }
}
