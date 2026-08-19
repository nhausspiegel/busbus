import { createRoot } from "react-dom/client";
import App from "./ui/App";
import DebugMap from "./ui/DebugMap";

// ?debug=1 keeps the raw-data view around for checking what the feeds contain.
const debug = new URLSearchParams(location.search).has("debug");

createRoot(document.getElementById("root")!).render(debug ? <DebugMap /> : <App />);
