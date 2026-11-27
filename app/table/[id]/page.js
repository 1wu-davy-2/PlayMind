import './table.css';
import TableClient from '@/components/TableClient';

export const metadata = {
  title: '牌桌',
};

export default async function Page({ params }) {
  const { id } = await params;
  return <TableClient roomId={id} />;
}
