import { KaminoGame } from "./game";
import "./style.css";

const root = document.querySelector<HTMLElement>("#game");

if (!root) throw new Error("Game root not found");

void new KaminoGame(root).initialize();
