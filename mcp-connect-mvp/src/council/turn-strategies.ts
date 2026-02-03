/**
 * Council: Turn Strategies
 * Logic for selecting which persona speaks next
 */

import type { Council, Persona, CouncilMessage, TurnStrategy } from './types';

/**
 * Get active (non-muted) personas from a council
 */
function getActivePersonas(council: Council): Persona[] {
  return council.personas.filter((p) => !p.muted);
}

/**
 * Get the last persona who spoke (excluding user and system)
 */
function getLastSpeaker(council: Council): Persona | null {
  for (let i = council.messages.length - 1; i >= 0; i--) {
    const message = council.messages[i];
    if (message.speakerType === 'persona') {
      return council.personas.find((p) => p.id === message.speakerId) || null;
    }
  }
  return null;
}

/**
 * Count how many times each persona has spoken
 */
function getSpeakCounts(council: Council): Map<string, number> {
  const counts = new Map<string, number>();
  for (const persona of council.personas) {
    counts.set(persona.id, 0);
  }
  for (const message of council.messages) {
    if (message.speakerType === 'persona') {
      counts.set(message.speakerId, (counts.get(message.speakerId) || 0) + 1);
    }
  }
  return counts;
}

/**
 * Round-Robin: Each persona speaks in fixed order
 */
function selectRoundRobin(council: Council): Persona | null {
  const active = getActivePersonas(council);
  if (active.length === 0) return null;

  const lastSpeaker = getLastSpeaker(council);
  if (!lastSpeaker) {
    return active[0]; // First persona starts
  }

  const lastIndex = active.findIndex((p) => p.id === lastSpeaker.id);
  const nextIndex = (lastIndex + 1) % active.length;
  return active[nextIndex];
}

/**
 * React: Respond to previous speaker (prefer opposing stance)
 */
function selectReact(council: Council): Persona | null {
  const active = getActivePersonas(council);
  if (active.length === 0) return null;

  const lastSpeaker = getLastSpeaker(council);
  if (!lastSpeaker) {
    return active[0];
  }

  // Find someone with opposing stance
  const lastStance = lastSpeaker.predisposition.stance;
  const opposingStances: Record<string, string[]> = {
    advocate: ['critic'],
    critic: ['advocate'],
    neutral: ['advocate', 'critic'],
    wildcard: ['neutral', 'critic'],
  };

  const candidates = active.filter(
    (p) =>
      p.id !== lastSpeaker.id &&
      opposingStances[lastStance]?.includes(p.predisposition.stance)
  );

  if (candidates.length > 0) {
    // Pick randomly among opposing stances
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // Fall back to anyone who hasn't spoken recently
  const counts = getSpeakCounts(council);
  const minCount = Math.min(...active.filter((p) => p.id !== lastSpeaker.id).map((p) => counts.get(p.id) || 0));
  const leastSpoken = active.filter((p) => p.id !== lastSpeaker.id && (counts.get(p.id) || 0) === minCount);

  return leastSpoken[0] || active.find((p) => p.id !== lastSpeaker.id) || null;
}

/**
 * Volunteer: Pick based on relevance to last message (simulated)
 * In practice, this would use semantic similarity
 */
function selectVolunteer(council: Council): Persona | null {
  const active = getActivePersonas(council);
  if (active.length === 0) return null;

  const lastSpeaker = getLastSpeaker(council);
  const counts = getSpeakCounts(council);

  // Weight by inverse of speak count and domain relevance
  const lastMessage = council.messages[council.messages.length - 1];
  const content = lastMessage?.content.toLowerCase() || '';

  const scored = active
    .filter((p) => p.id !== lastSpeaker?.id)
    .map((p) => {
      let score = 10 - (counts.get(p.id) || 0); // Prefer those who spoke less

      // Boost if their domain is mentioned
      if (p.predisposition.domain) {
        const domainTerms = p.predisposition.domain.toLowerCase().split(/\s+/);
        for (const term of domainTerms) {
          if (content.includes(term)) {
            score += 5;
          }
        }
      }

      // Boost if traits are relevant
      for (const trait of p.predisposition.traits) {
        if (content.includes(trait.toLowerCase())) {
          score += 2;
        }
      }

      return { persona: p, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.persona || null;
}

/**
 * Relevance: System picks most relevant voice based on topic keywords
 */
function selectRelevance(council: Council): Persona | null {
  // Similar to volunteer but more algorithmic
  return selectVolunteer(council);
}

/**
 * Parallel: All respond simultaneously (returns all active personas)
 */
function selectParallel(council: Council): Persona[] {
  return getActivePersonas(council);
}

/**
 * Get the next speaker(s) based on turn strategy
 */
export function selectNextSpeaker(
  council: Council,
  strategy?: TurnStrategy
): Persona | Persona[] | null {
  const effectiveStrategy = strategy || council.orchestration.turnStrategy;

  switch (effectiveStrategy) {
    case 'round-robin':
      return selectRoundRobin(council);
    case 'react':
      return selectReact(council);
    case 'volunteer':
      return selectVolunteer(council);
    case 'relevance':
      return selectRelevance(council);
    case 'parallel':
      return selectParallel(council);
    case 'popcorn':
      // Popcorn requires the last speaker to choose - return null for moderator to decide
      return null;
    case 'moderator':
      // Moderator mode - return null, user will specify
      return null;
    default:
      return selectRoundRobin(council);
  }
}

/**
 * Check if a round is complete (all personas have spoken once)
 */
export function isRoundComplete(council: Council): boolean {
  const active = getActivePersonas(council);
  const roundSize = council.orchestration.maxTurnsPerRound;

  // Count messages in current round
  let roundMessages = 0;
  for (let i = council.messages.length - 1; i >= 0; i--) {
    const message = council.messages[i];
    if (message.speakerType === 'system' && message.content.includes('Round')) {
      break; // Found previous round marker
    }
    if (message.speakerType === 'persona') {
      roundMessages++;
    }
  }

  return roundMessages >= Math.min(roundSize, active.length);
}

/**
 * Get personas who haven't spoken in current round
 */
export function getUnheardPersonas(council: Council): Persona[] {
  const active = getActivePersonas(council);
  const spokenInRound = new Set<string>();

  // Find who spoke in current round
  for (let i = council.messages.length - 1; i >= 0; i--) {
    const message = council.messages[i];
    if (message.speakerType === 'system' && message.content.includes('Round')) {
      break;
    }
    if (message.speakerType === 'persona') {
      spokenInRound.add(message.speakerId);
    }
  }

  return active.filter((p) => !spokenInRound.has(p.id));
}

/**
 * Select two personas for a debate
 */
export function selectDebateOpponents(council: Council): [Persona, Persona] | null {
  const active = getActivePersonas(council);
  if (active.length < 2) return null;

  // Find advocate and critic pair
  const advocates = active.filter((p) => p.predisposition.stance === 'advocate');
  const critics = active.filter((p) => p.predisposition.stance === 'critic');

  if (advocates.length > 0 && critics.length > 0) {
    return [advocates[0], critics[0]];
  }

  // Otherwise just pick first two
  return [active[0], active[1]];
}

/**
 * Calculate turn order for a full round
 */
export function calculateRoundOrder(council: Council): Persona[] {
  const strategy = council.orchestration.turnStrategy;
  const active = getActivePersonas(council);

  switch (strategy) {
    case 'round-robin':
      // Fixed order based on persona array position
      return [...active];

    case 'react':
    case 'relevance':
    case 'volunteer': {
      // Dynamic order - calculate now
      const order: Persona[] = [];
      const tempCouncil = { ...council };

      while (order.length < active.length) {
        const next = selectNextSpeaker(tempCouncil, strategy);
        if (!next || Array.isArray(next)) break;
        order.push(next);
        // Simulate adding a message
        tempCouncil.messages = [
          ...tempCouncil.messages,
          {
            id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            speakerId: next.id,
            speakerType: 'persona',
            content: '',
            tokensUsed: 0,
            latencyMs: 0,
          },
        ];
      }
      return order;
    }

    case 'parallel':
      return [...active];

    default:
      return [...active];
  }
}
