import type { SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = ({ size = 20, ...p }: P) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  ...p,
});

export const SearchIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m20 20-4.2-4.2" />
  </svg>
);
export const CloseIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);
export const BackIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);
export const ChevronRight = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);
export const PlusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);
export const MinusIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M5 12h14" />
  </svg>
);
export const MoreIcon = (p: P) => (
  <svg {...base(p)}>
    <circle cx="6" cy="12" r="1.2" fill="currentColor" />
    <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    <circle cx="18" cy="12" r="1.2" fill="currentColor" />
  </svg>
);
export const MapIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M9 4 3 6.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z" />
    <path d="M9 4v13M15 6.5v13" />
  </svg>
);
export const ExternalIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </svg>
);
export const TrashIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" />
  </svg>
);
export const FitWidthIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3" />
  </svg>
);
export const CloudOffIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M3 3l18 18M8 7.5A5.5 5.5 0 0 1 17.4 10H18a4 4 0 0 1 2.3 7.3M17 19H7a4.5 4.5 0 0 1-1.4-8.8" />
  </svg>
);
export const RefreshIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M20 11a8 8 0 0 0-14.8-4M4 4v4h4M4 13a8 8 0 0 0 14.8 4M20 20v-4h-4" />
  </svg>
);
export const StorageIcon = (p: P) => (
  <svg {...base(p)}>
    <ellipse cx="12" cy="6" rx="7" ry="2.8" />
    <path d="M5 6v12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8V6M5 12c0 1.5 3.1 2.8 7 2.8s7-1.3 7-2.8" />
  </svg>
);
export const BookIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15Z" />
    <path d="M4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5" />
  </svg>
);
export const ScrollIcon = (p: P) => (
  <svg {...base(p)}>
    <path d="M7 4h10M7 20h10M12 8v8M9 13l3 3 3-3" />
  </svg>
);
export const PagesIcon = (p: P) => (
  <svg {...base(p)}>
    <rect x="3.5" y="5" width="7.5" height="14" rx="1" />
    <rect x="13" y="5" width="7.5" height="14" rx="1" />
  </svg>
);

export function OwlMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden>
      <rect width="512" height="512" rx="112" fill="#1c1917" />
      <path
        d="M136 150 L196 196 L256 168 L316 196 L376 150 L372 300 C372 372 320 420 256 420 C192 420 140 372 140 300 Z"
        fill="#e7dcc8"
      />
      <circle cx="200" cy="262" r="58" fill="#1c1917" />
      <circle cx="312" cy="262" r="58" fill="#1c1917" />
      <circle cx="200" cy="262" r="34" fill="#f59e0b" />
      <circle cx="312" cy="262" r="34" fill="#f59e0b" />
      <circle cx="208" cy="256" r="12" fill="#1c1917" />
      <circle cx="320" cy="256" r="12" fill="#1c1917" />
      <path d="M240 318 L272 318 L256 346 Z" fill="#f59e0b" />
    </svg>
  );
}
