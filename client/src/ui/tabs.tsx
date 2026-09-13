import { Tabs as Base } from "@base-ui/react/tabs"
import type { ComponentPropsWithoutRef, ReactNode } from "react"

type RootProps = ComponentPropsWithoutRef<typeof Base.Root> & { variant?: "settings" }

function Root({ variant, ...rest }: RootProps) {
  return <Base.Root data-component="tabs" data-variant={variant} {...rest} />
}

function List(props: ComponentPropsWithoutRef<typeof Base.List>) {
  return <Base.List data-slot="tabs-list" {...props} />
}

function Trigger(props: ComponentPropsWithoutRef<typeof Base.Tab>) {
  return <Base.Tab data-slot="tabs-trigger" {...props} />
}

function Content(props: ComponentPropsWithoutRef<typeof Base.Panel>) {
  return <Base.Panel data-slot="tabs-content" {...props} />
}

/** Group heading above a run of triggers. */
function SectionTitle({ children }: { children?: ReactNode }) {
  return <div data-slot="tabs-section-title">{children}</div>
}

export const Tabs = Object.assign(Root, { List, Trigger, Content, SectionTitle })
