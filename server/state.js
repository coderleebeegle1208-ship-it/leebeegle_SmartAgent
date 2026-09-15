// Small shared runtime state (kept separate to avoid import cycles).
export const planPhase = new Set(); // agent ids currently in the pipeline's planning run
