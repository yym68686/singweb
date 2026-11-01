import { CircleSlash } from 'lucide-react'
import { ButtonLink } from '../components/Button'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/States'

export default function NotFound() {
  return (
    <>
      <PageHeader title="找不到这个页面" />
      <EmptyState icon={CircleSlash} title="404" action={<ButtonLink to="/">回到总览</ButtonLink>} />
    </>
  )
}
