import React from "react";
import ReactDOM from "react-dom/client";
import { HeroUIProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: 1,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <HeroUIProvider>
        <QueryClientProvider client={queryClient}>
          <main className="dark text-foreground bg-background min-h-screen">
            <App />
          </main>
        </QueryClientProvider>
      </HeroUIProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
