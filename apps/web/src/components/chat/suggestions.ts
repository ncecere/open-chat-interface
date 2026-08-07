import { Code2, Compass, GraduationCap, Sparkles } from 'lucide-react';

export const SUGGESTION_CATEGORIES = [
  {
    id: 'create',
    label: 'Create',
    icon: Sparkles,
    prompts: [
      'Write a short story about a robot discovering emotions',
      'Help me outline a sci-fi novel set in a post-apocalyptic world',
      'Create a character profile for a complex villain with sympathetic motives',
      'Give me 5 creative writing prompts for flash fiction',
    ],
  },
  {
    id: 'explore',
    label: 'Explore',
    icon: Compass,
    prompts: [
      'Good books for fans of Rick Rubin',
      'Countries ranked by number of corgis',
      'Most successful companies in the world',
      'How much does Claude cost?',
    ],
  },
  {
    id: 'code',
    label: 'Code',
    icon: Code2,
    prompts: [
      'Write code to invert a binary search tree in Python',
      "What's the difference between Promise.all and Promise.allSettled?",
      "Explain React's useEffect cleanup function",
      'Best practices for error handling in Rust',
    ],
  },
  {
    id: 'learn',
    label: 'Learn',
    icon: GraduationCap,
    prompts: [
      "Beginner's guide to TypeScript",
      'Explain the CAP theorem in distributed systems',
      'Why is AI so expensive?',
      'Are black holes real?',
    ],
  },
] as const;

export const DEFAULT_PROMPTS = [
  'How does AI work?',
  'Are black holes real?',
  'How many Rs are in the word "strawberry"?',
  'What is the meaning of life?',
];
