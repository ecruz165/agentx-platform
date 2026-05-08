import { Route, Routes, Navigate } from "react-router-dom";
import NavShell from "./components/NavShell";
import IntakePage from "./pages/Intake";
import SessionsPage from "./pages/Sessions";
import JobsPage from "./pages/Jobs";
import CatalogPage from "./pages/Catalog";

export default function App() {
  return (
    <NavShell>
      <Routes>
        <Route path="/" element={<Navigate to="/intake" replace />} />
        <Route path="/intake" element={<IntakePage />} />
        <Route path="/intake/:sessionId" element={<IntakePage />} />
        <Route path="/sessions" element={<SessionsPage />} />
        <Route path="/jobs" element={<JobsPage />} />
        <Route path="/catalog" element={<CatalogPage />} />
      </Routes>
    </NavShell>
  );
}
