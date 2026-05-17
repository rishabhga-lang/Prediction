const SUITS = ['H', 'D', 'C', 'S'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
/** Round-by-round trump: Spades → Hearts → Clubs → Diamonds → repeat */
const TRUMP_ROTATION = ['S', 'H', 'C', 'D'];

const TRUMP_NAMES = {
  S: 'Spades',
  H: 'Hearts',
  C: 'Clubs',
  D: 'Diamonds',
};

export function getTrumpForRound(roundNum) {
  return TRUMP_ROTATION[(roundNum - 1) % TRUMP_ROTATION.length];
}

const RANK_VALUES = Object.fromEntries(
  RANKS.map((r, i) => [r, i + 2])
);

export function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ rank, suit, value: RANK_VALUES[rank] });
    }
  }
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

export function cardKey(card) {
  return `${card.rank}-${card.suit}`;
}

export function determineWinner(playedCards, leadSuit, trumpSuit) {
  const entries = Object.entries(playedCards);
  const trumpCards = entries.filter(([, card]) => card.suit === trumpSuit);

  if (trumpCards.length > 0) {
    return trumpCards.reduce((best, cur) =>
      cur[1].value > best[1].value ? cur : best
    )[0];
  }

  const leadCards = entries.filter(([, card]) => card.suit === leadSuit);
  return leadCards.reduce((best, cur) =>
    cur[1].value > best[1].value ? cur : best
  )[0];
}

export function canPlayCard(hand, card, leadSuit) {
  if (leadSuit == null) return true;
  const hasLead = hand.some((c) => c.suit === leadSuit);
  if (hasLead) return card.suit === leadSuit;
  return true;
}

export function scoreRound(predictions, wins) {
  const results = {};
  for (const playerId of Object.keys(predictions)) {
    const pred = predictions[playerId];
    const actual = wins[playerId] ?? 0;

    if (pred === 0) {
      if (actual === 0) {
        results[playerId] = { points: 1, pred, actual, correct: true };
      } else {
        results[playerId] = { points: -1, pred, actual, correct: false };
      }
      continue;
    }

    if (pred === actual) {
      results[playerId] = { points: actual, pred, actual, correct: true };
    } else {
      results[playerId] = {
        points: -pred,
        pred,
        actual,
        correct: false,
      };
    }
  }
  return results;
}

export { SUITS, RANKS, TRUMP_ROTATION, TRUMP_NAMES, RANK_VALUES };
