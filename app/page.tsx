import { redirect } from 'next/navigation';

// Proxy gates this; reaching here means the operator cookie is valid.
export default function Home() {
  redirect('/admin');
}
