interface BrandLogoProps {
  className?: string
}

export function BrandLogo({ className = 'h-10 w-10' }: BrandLogoProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      role="img"
      aria-label="CipherTransLocal logo"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="48" height="48" rx="12" fill="#111827" />
      <path
        d="M32 14.5H21.5C16.3 14.5 12 18.8 12 24s4.3 9.5 9.5 9.5H32"
        fill="none"
        stroke="#F8FAFC"
        strokeWidth="4.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21.5 24H35"
        fill="none"
        stroke="#38BDF8"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M31 20.5 34.5 24 31 27.5"
        fill="none"
        stroke="#38BDF8"
        strokeWidth="3.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="1" y="1" width="46" height="46" rx="11" fill="none" stroke="#FFFFFF" strokeOpacity="0.1" />
    </svg>
  )
}
