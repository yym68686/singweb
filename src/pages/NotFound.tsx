import { CircleSlash } from 'lucide-react'
import { ButtonLink } from '../components/Button'
import { PageHeader } from '../components/PageHeader'
import { EmptyState } from '../components/States'

export default function NotFound() {
  return (
    <>
      <PageHeader title="找不到这个页面" />
      <EmptyState icon={CircleSlash} title="这个地址没有对应的页面" action={<ButtonLink to="/">回到总览</ButtonLink>}>
        链接可能写错了，或者页面已经移走。
      </EmptyState>
    </>
  )
}
