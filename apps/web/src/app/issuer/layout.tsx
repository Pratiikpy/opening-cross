import { IssuerShell } from '@/components/issuer/issuer-shell';

// Every page of the issuer area sits in the same frame; each page supplies its own heading through `IssuerPage`.
export default function IssuerLayout({ children }: { children: React.ReactNode }) {
  return <IssuerShell>{children}</IssuerShell>;
}
