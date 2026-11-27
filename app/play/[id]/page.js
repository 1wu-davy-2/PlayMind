import { redirect } from 'next/navigation';

// 旧链接兼容：/play/:id → /table/:id
export default async function Page({ params }) {
  const { id } = await params;
  redirect('/table/' + id);
}
