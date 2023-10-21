import React from "react";
import { shallow } from "enzyme";
import Info from "./Info";

describe("Info Component", () => {
  let wrapper;
  const props = {
    weight: "50",
    height: "176",
    id: "2b926f1b-db1f-45ac-af87-2130da1e1a2f",
    date: "10/25/2019",
    bmi: "16.14",
    deleteCard: jest.fn()
  };
  beforeEach(() => {
    wrapper = shallow(<Info {...props} />);
  });

  it("renders", () => {
    expect(wrapper).not.toBeNull();
  });

  it("renders with props", () => {
    expect(wrapper.find("[data-test='bmi']").text()).toEqual("BMI: 16.14");

    expect(wrapper.find("[data-test='weight']").text()).toEqual(
      "Weight: 50 kg"
    );

    expect(wrapper.find("[data-test='height']").text()).toEqual(
      "Height: 176 cm"
    );

    expect(wrapper.find("[data-test='date']").text()).toEqual(
      "Date: 10/25/2019"
    );
  });

  it("should delete the card", () => {
    wrapper.find("button").simulate("click");

    expect(props.deleteCard).toHaveBeenCalledTimes(1);
  });
});
