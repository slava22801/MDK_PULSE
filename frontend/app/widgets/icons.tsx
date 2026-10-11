/**
 * Иконки магазина.
 *
 * Набор взят из макета Figma (layerless-иконки Lucide: `map-pin`, `zap`,
 * `shopping-cart` и т.д.). Держим их здесь, а не в библиотеке: список
 * фиксирован дизайном, а лишние килобайты в бандл главной не нужны.
 *
 * Все иконки декоративные и скрыты от скринридера — подпись рядом с ними
 * всегда текстовая.
 */

type IconProps = {
  className?: string;
  /** Иконка наследует `currentColor` и размер по умолчанию из класса. */
  strokeWidth?: number;
};

function icon(path: React.ReactNode, viewBox = "0 0 24 24") {
  return function Icon({ className = "h-5 w-5", strokeWidth = 1.75 }: IconProps) {
    return (
      <svg
        viewBox={viewBox}
        aria-hidden="true"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {path}
      </svg>
    );
  };
}

export const MapPin = icon(
  <>
    <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0116 0z" />
    <circle cx="12" cy="10" r="3" />
  </>,
);

export const ChevronDown = icon(<path d="M6 9l6 6 6-6" />);

export const ChevronUp = icon(<path d="M18 15l-6-6-6 6" />);

export const ChevronRight = icon(<path d="M9 18l6-6-6-6" />);

export const Zap = icon(<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />);

export const Menu = icon(
  <>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </>,
);

export const Search = icon(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="M20 20l-3.5-3.5" />
  </>,
);

export const UserRound = icon(
  <>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21a8 8 0 0116 0" />
  </>,
);

export const Heart = icon(
  <path d="M20.8 6.6a5 5 0 00-7.1 0L12 8.3l-1.7-1.7a5 5 0 10-7.1 7.1L12 22l8.8-8.3a5 5 0 000-7.1z" />,
);

export const ChartColumn = icon(
  <>
    <path d="M12 20V10" />
    <path d="M18 20V4" />
    <path d="M6 20v-4" />
  </>,
);

export const ShoppingCart = icon(
  <>
    <circle cx="9" cy="20" r="1.5" />
    <circle cx="18" cy="20" r="1.5" />
    <path d="M2 3h3l2.2 11.2a2 2 0 002 1.6h7.7a2 2 0 002-1.6L21 7H6" />
  </>,
);

export const Truck = icon(
  <>
    <path d="M2 6h11v10H2z" />
    <path d="M13 9h4l3 3v4h-7z" />
    <circle cx="6" cy="18" r="2" />
    <circle cx="17" cy="18" r="2" />
  </>,
);

export const ShieldCheck = icon(
  <>
    <path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z" />
    <path d="M9 12l2 2 4-4" />
  </>,
);

export const PackageCheck = icon(
  <>
    <path d="M12 3l8 4v10l-8 4-8-4V7l8-4z" />
    <path d="M4 7l8 4 8-4" />
    <path d="M12 11v10" />
    <path d="M9 14l2 2 4-4" />
  </>,
);

export const Cpu = icon(
  <>
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M10 3v4M14 3v4M10 17v4M14 17v4M3 10h4M3 14h4M17 10h4M17 14h4" />
  </>,
);

export const Gpu = icon(
  <>
    <rect x="2" y="7" width="20" height="10" rx="2" />
    <circle cx="9" cy="12" r="3" />
    <path d="M15 10h4M15 14h4" />
  </>,
);

export const HardDrive = icon(
  <>
    <rect x="3" y="5" width="18" height="6" rx="1.5" />
    <rect x="3" y="13" width="18" height="6" rx="1.5" />
    <path d="M7 8h.01M7 16h.01" />
  </>,
);

export const Plug = icon(
  <>
    <path d="M9 3v6M15 3v6" />
    <path d="M6 9h12v3a6 6 0 01-6 6 6 6 0 01-6-6V9z" />
    <path d="M12 18v3" />
  </>,
);

export const PcCase = icon(
  <>
    <rect x="4" y="3" width="16" height="18" rx="2" />
    <circle cx="9" cy="8" r="1.5" />
    <path d="M14 7h4M14 10h4M6 18h5" />
  </>,
);

export const Fan = icon(
  <>
    <circle cx="12" cy="12" r="2.5" />
    <path d="M12 9.5c0-4 1-6.5 3-6.5s2 4.5-1 6.5" />
    <path d="M14.5 12c4 0 6.5 1 6.5 3S16 15 14.5 13" />
    <path d="M9.5 14c-4 0-6.5-1-6.5-3S8 9 9.5 11" />
  </>,
);

export const Monitor = icon(
  <>
    <rect x="3" y="4" width="18" height="12" rx="2" />
    <path d="M9 20h6M12 16v4" />
  </>,
);

export const Keyboard = icon(
  <>
    <rect x="2" y="6" width="20" height="12" rx="2" />
    <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M8 14h8" />
  </>,
);

export const Mouse = icon(
  <>
    <rect x="6" y="3" width="12" height="18" rx="6" />
    <path d="M12 7v3" />
  </>,
);

export const Headphones = icon(
  <>
    <path d="M4 14v-2a8 8 0 0116 0v2" />
    <path d="M4 14h3v6H5a1 1 0 01-1-1v-5z" />
    <path d="M20 14h-3v6h2a1 1 0 001-1v-5z" />
  </>,
);

export const Cable = icon(
  <>
    <path d="M4 4v6a4 4 0 004 4h8a4 4 0 014 4v2" />
    <path d="M8 4h4M8 7h4" />
    <rect x="2.5" y="2.5" width="3" height="3" rx="1" />
    <rect x="18.5" y="18.5" width="3" height="3" rx="1" />
  </>,
);

export const Usb = icon(
  <>
    <path d="M12 21V4" />
    <circle cx="12" cy="21" r="1.5" />
    <path d="M12 8l5-3v4l-5-1z" />
    <path d="M12 14l-5-3v4l5 1z" />
  </>,
);

export const SlidersHorizontal = icon(
  <>
    <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
    <circle cx="16" cy="7" r="2" />
    <circle cx="10" cy="17" r="2" />
  </>,
);

export const X = icon(
  <>
    <path d="M6 6l12 12M18 6L6 18" />
  </>,
);

export const Check = icon(<path d="M5 13l4 4 10-10" />);

export const ArrowRight = icon(
  <>
    <path d="M4 12h16" />
    <path d="M14 6l6 6-6 6" />
  </>,
);

export const ArrowUpRight = icon(
  <>
    <path d="M7 17L17 7" />
    <path d="M8 7h9v9" />
  </>,
);

export const Plus = icon(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
);

export const LayoutGrid = icon(
  <>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </>,
);

export const ListIcon = icon(
  <>
    <path d="M8 6h13M8 12h13M8 18h13" />
    <path d="M3 6h.01M3 12h.01M3 18h.01" />
  </>,
);

export const Star = icon(
  <path d="M10 1.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8L10 14.9l-5.3 2.7 1-5.8L1.5 7.7l5.9-.9L10 1.5z" />,
);