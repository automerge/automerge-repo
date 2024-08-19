// This is a helper component copied from the react-arborist library.
// It provides a width/height value for filling a flex layout parent.
// These values can then be passed down to a child component.

import React, { ReactElement } from "react";
import useResizeObserver from "use-resize-observer";

type AnyRef = React.MutableRefObject<any> | React.RefCallback<any> | null;

function mergeRefs(...refs: AnyRef[]) {
  return (instance: any) => {
    refs.forEach((ref) => {
      if (typeof ref === "function") {
        ref(instance);
      } else if (ref != null) {
        ref.current = instance;
      }
    });
  };
}

type Props = {
  children: (dimens: { width: number; height: number }) => ReactElement;
};

const style = {
  flex: 1,
  width: "100%",
  height: "100%",
  minHeight: 0,
  minWidth: 0,
};

export const FillFlexParent = React.forwardRef(function FillFlexParent(
  props: Props,
  forwardRef
) {
  const { ref, width, height } = useResizeObserver();
  return (
    <div style={style} ref={mergeRefs(ref, forwardRef)}>
      {width && height ? props.children({ width, height }) : null}
    </div>
  );
});

