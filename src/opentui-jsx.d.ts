import type { Key } from "react"

// TypeScript 6 does not preserve React's inherited `key` attribute through
// OpenTUI's JSX runtime declarations for custom components.
declare module "@opentui/react/jsx-runtime" {
	namespace JSX {
		interface IntrinsicAttributes {
			readonly key?: Key | null | undefined
		}
	}
}
